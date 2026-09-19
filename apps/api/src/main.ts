import { connect, migrateToLatest } from '@vdeploy/db';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const { db, close } = connect(config.DATABASE_URL);
await migrateToLatest(db);
const app = await buildServer({ config, db });

// Finish in-flight requests, then release the database, on any stop signal.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().then(close, close);
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
