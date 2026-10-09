import fs from 'node:fs';
import path from 'node:path';
import knexFactory, { type Knex } from 'knex';
import { migrations } from './migrations.js';

export type Db = Knex;

export function createDb(databaseUrl: string): Knex {
  if (databaseUrl.startsWith('sqlite:')) {
    const file = databaseUrl.slice('sqlite:'.length);
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    return knexFactory({
      client: 'better-sqlite3',
      connection: { filename: file },
      useNullAsDefault: true,
      pool: {
        afterCreate: (conn: any, done: (err: Error | null, conn: any) => void) => {
          conn.pragma('foreign_keys = ON');
          conn.pragma('journal_mode = WAL');
          done(null, conn);
        },
      },
    });
  }
  if (databaseUrl.startsWith('mysql:')) {
    return knexFactory({
      client: 'mysql2',
      connection: { uri: databaseUrl, charset: 'utf8mb4', supportBigNumbers: true, bigNumberStrings: false } as any,
      pool: { min: 0, max: 10 },
    });
  }
  throw new Error('DATABASE_URL muss mit mysql:// oder sqlite: beginnen');
}

export function isMysql(db: Knex): boolean {
  return db.client.config.client === 'mysql2';
}

export async function migrate(db: Knex): Promise<void> {
  await db.migrate.latest({
    migrationSource: {
      getMigrations: async () => Object.keys(migrations),
      getMigrationName: (name: string) => name,
      getMigration: async (name: string) => migrations[name],
    },
  });
}
