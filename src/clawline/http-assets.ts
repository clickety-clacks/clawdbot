import type { Statement } from "better-sqlite3";
import type http from "node:http";
import Busboy from "busboy";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Logger, ProviderConfig } from "./domain.js";
import { ClientMessageError, HttpError } from "./errors.js";

export type AuthDetails = { deviceId: string; userId: string; isAdmin: boolean };

export type AssetHandlerDeps = {
  config: ProviderConfig;
  tmpDir: string;
  assetsDir: string;
  logger: Logger;
  selectAssetStmt: Statement;
  deleteAssetStmt: Statement;
  insertAssetStmt: Statement;
  selectExpiredAssetsStmt: Statement;
  enqueueWriteTask: <T>(task: () => T | Promise<T>) => Promise<T>;
  authenticateHttpRequest: (req: http.IncomingMessage) => AuthDetails;
  sendHttpError: (res: http.ServerResponse, status: number, code: string, message: string) => void;
  safeUnlink: (filePath: string) => Promise<void>;
  nowMs: () => number;
  assetIdRegex: RegExp;
  canAccessAsset?: (params: { assetOwnerId: string; auth: AuthDetails }) => boolean;
};

export function createAssetHandlers(deps: AssetHandlerDeps) {
  const {
    config,
    tmpDir,
    assetsDir,
    logger,
    selectAssetStmt,
    deleteAssetStmt,
    insertAssetStmt,
    selectExpiredAssetsStmt,
    enqueueWriteTask,
    authenticateHttpRequest,
    sendHttpError,
    safeUnlink,
    nowMs,
    assetIdRegex,
    canAccessAsset,
  } = deps;

  async function handleUpload(req: http.IncomingMessage, res: http.ServerResponse) {
    let tmpPath: string | undefined;
    try {
      const auth = authenticateHttpRequest(req);
      const assetId = `a_${randomUUID()}`;
      tmpPath = path.join(tmpDir, `${assetId}.tmp`);
      let detectedMime = "application/octet-stream";
      let size = 0;
      await new Promise<void>((resolve, reject) => {
        const busboy = Busboy({
          headers: req.headers,
          limits: { files: 1, fileSize: config.media.maxUploadBytes },
        });
        let handled = false;
        let settled = false;
        let writeDone: Promise<void> | null = null;
        const finish = (err?: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          if (err) {
            reject(err);
            return;
          }
          resolve();
        };
        busboy.on("file", (fieldname, file, info) => {
          if (handled || fieldname !== "file") {
            handled = true;
            file.resume();
            finish(new ClientMessageError("invalid_message", "Invalid upload field"));
            return;
          }
          handled = true;
          detectedMime = info.mimeType || "application/octet-stream";
          const writeStream = createWriteStream(tmpPath!);
          let aborted = false;
          writeDone = new Promise<void>((writeResolve, writeReject) => {
            writeStream.on("finish", writeResolve);
            writeStream.on("error", writeReject);
          });
          file.on("data", (chunk) => {
            size += chunk.length;
            if (!aborted && size > config.media.maxUploadBytes) {
              aborted = true;
              file.unpipe(writeStream);
              writeStream.destroy();
              file.resume();
              finish(new ClientMessageError("payload_too_large", "Upload too large"));
            }
          });
          file.on("limit", () =>
            finish(new ClientMessageError("payload_too_large", "Upload too large")),
          );
          file.on("error", finish);
          file.pipe(writeStream);
          file.on("end", () => writeStream.end());
        });
        busboy.on("finish", () => {
          if (!handled) {
            finish(new ClientMessageError("invalid_message", "Missing file field"));
            return;
          }
          if (writeDone) {
            writeDone.then(() => finish(), finish);
          } else {
            finish();
          }
        });
        busboy.on("error", finish);
        req.pipe(busboy);
      });
      if (size === 0) {
        throw new ClientMessageError("invalid_message", "Empty upload");
      }
      const finalPath = path.join(assetsDir, assetId);
      await fs.rename(tmpPath, finalPath);
      try {
        await enqueueWriteTask(() =>
          insertAssetStmt.run(assetId, auth.userId, detectedMime, size, nowMs(), auth.deviceId),
        );
      } catch (err) {
        await safeUnlink(finalPath);
        throw err;
      }
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ assetId, mimeType: detectedMime, size }));
    } catch (err) {
      if (tmpPath) {
        await safeUnlink(tmpPath);
      }
      if (err instanceof HttpError) {
        sendHttpError(res, err.status, err.code, err.message);
        return;
      }
      if (err instanceof ClientMessageError) {
        const status = err.code === "payload_too_large" ? 413 : 400;
        sendHttpError(res, status, err.code, err.message);
        return;
      }
      logger.error("upload_failed", err);
      sendHttpError(res, 503, "upload_failed_retryable", "Upload failed");
    }
  }

  async function handleDownload(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    assetId: string,
  ) {
    try {
      const auth = authenticateHttpRequest(req);
      if (!assetIdRegex.test(assetId)) {
        sendHttpError(res, 400, "invalid_message", "Invalid assetId");
        return;
      }
      const asset = selectAssetStmt.get(assetId) as
        | { assetId: string; userId: string; mimeType: string; size: number }
        | undefined;
      if (!asset) {
        sendHttpError(res, 404, "asset_not_found", "Asset not found");
        return;
      }
      const ownsAsset = asset.userId === auth.userId;
      const hasSharedAccess =
        !ownsAsset && typeof canAccessAsset === "function"
          ? canAccessAsset({ assetOwnerId: asset.userId, auth })
          : false;
      if (!ownsAsset && !hasSharedAccess) {
        sendHttpError(res, 404, "asset_not_found", "Asset not found");
        return;
      }
      const filePath = path.join(assetsDir, assetId);
      let fileHandle: fs.FileHandle;
      try {
        fileHandle = await fs.open(filePath, "r");
      } catch (err) {
        const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
        if (code === "ENOENT") {
          await enqueueWriteTask(() => deleteAssetStmt.run(assetId));
          sendHttpError(res, 404, "asset_not_found", "Asset not found");
          return;
        }
        throw err;
      }
      res.writeHead(200, {
        "Content-Type": asset.mimeType || "application/octet-stream",
        "Content-Length": asset.size,
      });
      const stream = fileHandle.createReadStream();
      stream.on("error", (err) => {
        logger.error("download_stream_failed", err);
        if (!res.headersSent) {
          sendHttpError(res, 500, "server_error", "Download failed");
        } else {
          res.end();
        }
      });
      stream.on("close", () => {
        fileHandle.close().catch(() => {});
      });
      stream.pipe(res);
    } catch (err) {
      if (err instanceof HttpError) {
        sendHttpError(res, err.status, err.code, err.message);
        return;
      }
      logger.error("download_failed", err);
      sendHttpError(res, 500, "server_error", "Download failed");
    }
  }

  async function cleanupTmpDirectory() {
    try {
      const entries = await fs.readdir(tmpDir);
      await Promise.all(entries.map((entry) => safeUnlink(path.join(tmpDir, entry))));
    } catch (err) {
      logger.warn("tmp_cleanup_failed", err);
    }
  }

  async function cleanupOrphanedAssetFiles() {
    const startedAt = nowMs();
    try {
      const entries = await fs.readdir(assetsDir);
      const now = nowMs();
      const batchSize = 10_000;
      for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);
        for (const entry of batch) {
          if (!assetIdRegex.test(entry)) {
            continue;
          }
          const asset = selectAssetStmt.get(entry);
          if (asset) {
            continue;
          }
          const filePath = path.join(assetsDir, entry);
          if (config.media.unreferencedUploadTtlSeconds > 0) {
            try {
              const stats = await fs.stat(filePath);
              const ageMs = now - stats.mtimeMs;
              if (ageMs < config.media.unreferencedUploadTtlSeconds * 1000) {
                continue;
              }
            } catch {
              continue;
            }
          }
          await safeUnlink(filePath);
        }
      }
    } catch (err) {
      logger.warn("asset_orphan_scan_failed", err);
    } finally {
      const elapsedMs = nowMs() - startedAt;
      if (elapsedMs > 30_000) {
        logger.warn("asset_orphan_scan_slow", { elapsedMs });
      }
    }
  }

  async function cleanupUnreferencedAssets() {
    if (config.media.unreferencedUploadTtlSeconds <= 0) {
      return;
    }
    const cutoff = nowMs() - config.media.unreferencedUploadTtlSeconds * 1000;
    const deletedAssetIds = await enqueueWriteTask(() => {
      const rows = selectExpiredAssetsStmt.all(cutoff) as { assetId: string }[];
      const deleted: string[] = [];
      for (const row of rows) {
        const result = deleteAssetStmt.run(row.assetId);
        if (result.changes > 0) {
          deleted.push(row.assetId);
        }
      }
      return deleted;
    });
    for (const assetId of deletedAssetIds) {
      const assetPath = path.join(assetsDir, assetId);
      await safeUnlink(assetPath);
    }
  }

  return {
    handleUpload,
    handleDownload,
    cleanupTmpDirectory,
    cleanupOrphanedAssetFiles,
    cleanupUnreferencedAssets,
  };
}
