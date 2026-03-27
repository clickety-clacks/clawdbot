declare module "busboy" {
  import type { EventEmitter } from "node:events";
  import type { Readable } from "node:stream";

  export type BusboyInfo = {
    filename: string;
    encoding: string;
    mimeType: string;
  };

  export type BusboyFileStream = Readable & {
    truncated?: boolean;
    resume(): void;
    pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T;
    unpipe(destination?: NodeJS.WritableStream): this;
  };

  export interface Busboy extends EventEmitter, NodeJS.WritableStream {
    on(
      event: "file",
      listener: (fieldname: string, file: BusboyFileStream, info: BusboyInfo) => void,
    ): this;
    on(event: "finish", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export interface BusboyConfig {
    headers: Record<string, string | string[] | undefined>;
    limits?: {
      files?: number;
      fileSize?: number;
    };
  }

  export default function Busboy(config: BusboyConfig): Busboy;
}
