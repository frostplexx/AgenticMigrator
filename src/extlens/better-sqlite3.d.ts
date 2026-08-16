/**
 * Minimal ambient types for better-sqlite3 (the package ships no bundled
 * types). Covers exactly the API surface the extlens registry uses; mirrors
 * the declaration the extlens-sdk ships for FolderBackend, plus `pragma`.
 */
declare module "better-sqlite3" {
    namespace Database {
        interface RunResult {
            changes: number;
            lastInsertRowid: number | bigint;
        }

        interface Statement {
            run(...params: unknown[]): RunResult;
            get(...params: unknown[]): Record<string, unknown> | undefined;
            all(...params: unknown[]): Record<string, unknown>[];
        }

        interface Database {
            exec(sql: string): void;
            prepare(sql: string): Statement;
            pragma(sql: string): unknown;
            close(): void;
        }
    }

    interface DatabaseConstructor {
        new (filename: string | Buffer): Database.Database;
    }

    const Database: DatabaseConstructor;
    export = Database;
}
