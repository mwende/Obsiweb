import { parseArgs } from 'node:util';
import { hashPassword, randomToken, validateNewPassword } from './auth/passwords.js';
import { createUser, findUserByEmail } from './auth/users.js';
import { loadConfig } from './config.js';
import { createDb, migrate } from './db/knex.js';

const [command, ...rest] = process.argv.slice(2);
const config = loadConfig();
const db = createDb(config.databaseUrl);

try {
  switch (command) {
    case 'migrate':
      await migrate(db);
      console.log('Migrationen ausgeführt.');
      break;

    case 'user:create':
    case 'user:reset-password': {
      const { values } = parseArgs({
        args: rest,
        options: { email: { type: 'string' }, name: { type: 'string' }, admin: { type: 'boolean', default: false } },
      });
      if (!values.email) throw new Error('--email fehlt');
      await migrate(db);
      // Passwort wird generiert, damit es nicht in der Shell-History landet
      const password = randomToken(15);
      validateNewPassword(password);
      const existing = await findUserByEmail(db, values.email);
      if (command === 'user:create') {
        if (existing) throw new Error(`Nutzer ${values.email} existiert bereits`);
        await createUser(db, {
          email: values.email,
          displayName: values.name ?? values.email,
          passwordHash: await hashPassword(password),
          isAdmin: values.admin,
        });
        console.log(`Nutzer ${values.email} angelegt${values.admin ? ' (Admin)' : ''}.`);
      } else {
        if (!existing) throw new Error(`Nutzer ${values.email} nicht gefunden`);
        await db('users').where({ id: existing.id }).update({ password_hash: await hashPassword(password) });
        console.log(`Passwort für ${values.email} zurückgesetzt.`);
      }
      console.log(`Initiales Passwort: ${password}\nBitte nach dem ersten Login unter „Einstellungen“ ändern.`);
      break;
    }

    default:
      console.log('Befehle: migrate | user:create --email <mail> [--name <name>] [--admin] | user:reset-password --email <mail>');
      process.exitCode = 1;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
