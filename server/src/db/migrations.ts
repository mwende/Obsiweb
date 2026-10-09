import type { Knex } from 'knex';

type Migration = { up: (db: Knex) => Promise<void>; down: (db: Knex) => Promise<void> };

const isMysql = (db: Knex) => db.client.config.client === 'mysql2';

export const migrations: Record<string, Migration> = {
  '001_initial': {
    async up(db) {
      await db.schema.createTable('users', (t) => {
        t.increments('id').primary();
        t.string('email', 255).notNullable().unique();
        t.string('display_name', 255).notNullable();
        t.string('password_hash', 255).nullable();
        t.boolean('is_admin').notNullable().defaultTo(false);
        t.string('entra_oid', 64).nullable().unique();
        t.string('tenant_id', 64).nullable();
        t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
      });

      await db.schema.createTable('sessions', (t) => {
        t.string('id', 64).primary(); // sha256 des Cookie-Tokens
        t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
        t.string('csrf', 64).notNullable();
        t.bigInteger('expires_at').notNullable();
        t.index(['user_id']);
      });

      await db.schema.createTable('app_passwords', (t) => {
        t.increments('id').primary();
        t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
        t.string('label', 255).notNullable();
        t.string('hash', 64).notNullable().unique(); // sha256 des Tokens
        t.bigInteger('last_used_at').nullable();
        t.timestamp('created_at').notNullable().defaultTo(db.fn.now());
        t.index(['user_id']);
      });

      await db.schema.createTable('files', (t) => {
        t.bigIncrements('id').primary();
        t.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE');
        t.string('path', 1024).notNullable();
        t.string('path_hash', 64).notNullable();
        t.boolean('is_dir').notNullable().defaultTo(false);
        t.bigInteger('size').notNullable().defaultTo(0);
        t.bigInteger('mtime_ms').notNullable();
        t.string('etag', 80).nullable();
        t.string('mime', 255).nullable();
        if (isMysql(db)) t.specificType('content', 'MEDIUMTEXT').nullable();
        else t.text('content').nullable();
        t.unique(['user_id', 'path_hash']);
      });
      if (isMysql(db)) {
        await db.raw('ALTER TABLE files ADD FULLTEXT INDEX ft_files (path, content)');
      }
    },
    async down(db) {
      await db.schema.dropTableIfExists('files');
      await db.schema.dropTableIfExists('app_passwords');
      await db.schema.dropTableIfExists('sessions');
      await db.schema.dropTableIfExists('users');
    },
  },
};
