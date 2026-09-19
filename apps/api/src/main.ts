import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { connect, createApplyQueue, enqueuePlan, migrateToLatest } from '@vdeploy/db';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

// Outbound calls (breached-password check, SMTP) must survive slow networks:
// Node's default 250 ms per address makes every attempt time out there.
setDefaultAutoSelectFamilyAttemptTimeout(2500);

const config = loadConfig();
const { db, close } = connect(config.DATABASE_URL);
await migrateToLatest(db);
const applyQueue = createApplyQueue(config.DATABASE_URL);
const app = await buildServer({
  config,
  db,
  queue: { enqueue: (planId) => enqueuePlan(applyQueue, planId) },
});

// Finish in-flight requests, then release the queue and the database, on any stop signal.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => applyQueue.close())
      .then(close, close);
  });
}

await app.listen({ host: config.HOST, port: config.PORT });
