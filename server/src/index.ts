import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb, migrate } from './db/knex.js';

const config = loadConfig();
const db = createDb(config.databaseUrl);
await migrate(db);
const { app, store } = await buildApp(config, db, {
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

await app.listen({ port: config.port, host: config.host });
app.log.info(`WebDAV: ${config.baseUrl}/dav/  ·  Entra ID: ${config.entra ? 'aktiv' : 'aus'}`);

// Index im Hintergrund mit dem Dateisystem abgleichen (z.B. nach Restore eines Backups)
void (async () => {
  const users: Array<{ id: number }> = await db('users').select('id');
  for (const u of users) {
    try {
      const r = await store.forUser(u.id).reconcile();
      if (r.updated || r.removed) app.log.info({ userId: u.id, ...r }, 'Index abgeglichen');
    } catch (err) {
      app.log.error({ err, userId: u.id }, 'Index-Abgleich fehlgeschlagen');
    }
  }
})();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.destroy();
    process.exit(0);
  });
}
