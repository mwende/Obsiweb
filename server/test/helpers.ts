import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { createAppPassword } from '../src/auth/appPasswords.js';
import { hashPassword } from '../src/auth/passwords.js';
import { createUser } from '../src/auth/users.js';
import { loadConfig } from '../src/config.js';
import { createDb, migrate } from '../src/db/knex.js';

export const PASSWORD = 'correct horse battery';

export async function makeTestEnv() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ow-test-'));
  const config = loadConfig({
    SESSION_SECRET: 'x'.repeat(40),
    DATABASE_URL: `sqlite:${path.join(dir, 'db.sqlite')}`,
    DATA_DIR: path.join(dir, 'data'),
    BASE_URL: 'http://localhost:3000',
    MAX_UPLOAD_MB: '5',
    WEB_DIST: path.join(dir, 'no-web'),
  });
  const db = createDb(config.databaseUrl);
  await migrate(db);
  const { app, store } = await buildApp(config, db);
  const hash = await hashPassword(PASSWORD);
  const alice = await createUser(db, { email: 'alice@example.com', displayName: 'Alice', passwordHash: hash, isAdmin: true });
  const bob = await createUser(db, { email: 'bob@example.com', displayName: 'Bob', passwordHash: hash });
  const aliceToken = (await createAppPassword(db, alice.id, 'test')).token;
  const bobToken = (await createAppPassword(db, bob.id, 'test')).token;
  const basic = (email: string, token: string) => `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  return {
    dir,
    config,
    db,
    app,
    store,
    alice,
    bob,
    aliceToken,
    aliceAuth: basic(alice.email, aliceToken),
    bobAuth: basic(bob.email, bobToken),
    async close() {
      await app.close();
      await db.destroy();
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

export type TestEnv = Awaited<ReturnType<typeof makeTestEnv>>;
