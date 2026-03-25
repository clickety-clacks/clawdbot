declare module "better-sqlite3" {
  export type SqliteValue = string | number | bigint | Buffer | null;
  export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export interface Statement<Result = unknown> {
    all(...params: SqliteValue[]): Result[];
    get(...params: SqliteValue[]): Result | undefined;
    run(...params: SqliteValue[]): RunResult;
  }

  export interface Database {
    prepare<Result = unknown>(source: string): Statement<Result>;
    pragma(name: string, options?: { simple?: boolean }): unknown;
    close(): void;
    exec(source: string): this;
    transaction<TArgs extends unknown[], TResult>(
      fn: (...args: TArgs) => TResult,
    ): (...args: TArgs) => TResult;
  }

  export interface Options {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
  }

  export default class BetterSqlite3 implements Database {
    constructor(path: string, options?: Options);
    prepare<Result = unknown>(source: string): Statement<Result>;
    pragma(name: string, options?: { simple?: boolean }): unknown;
    close(): void;
    exec(source: string): this;
    transaction<TArgs extends unknown[], TResult>(
      fn: (...args: TArgs) => TResult,
    ): (...args: TArgs) => TResult;
  }
}
