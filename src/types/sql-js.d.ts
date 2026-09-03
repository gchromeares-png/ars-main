declare module "sql.js" {
  export interface SqlJsConfig {
    locateFile?: (file: string) => string;
  }

  export interface Statement {
    bind(values?: unknown[] | Record<string, unknown>): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  }

  export interface Database {
    run(sql: string, params?: unknown[] | Record<string, unknown>): Database;
    prepare(sql: string, params?: unknown[] | Record<string, unknown>): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database;
  }

  const initSqlJs: (config?: SqlJsConfig) => Promise<SqlJsStatic>;
  export default initSqlJs;
}
