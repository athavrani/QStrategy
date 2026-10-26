import { loadConfig } from './config.js';
import { RelayDb } from './db.js';
import { buildApp } from './server.js';
import { createUpstream } from './upstream.js';
import { createEgressWatch } from './watch.js';

const config = loadConfig();
const db = new RelayDb(config.dbPath);
const upstream = createUpstream(config);
const app = buildApp({ config, db, upstream, logger: true });

const purge = setInterval(() => db.purge(Date.now()), 10 * 60_000);
purge.unref();
db.purge(Date.now());

// Warm the egress IP so responses carry it from the first request, then watch it for changes.
const watch = createEgressWatch({ upstream, webhookUrl: config.alertWebhookUrl, log: (m) => app.log.warn(m) });
void watch.checkOnce();
const watchTimer = setInterval(() => void watch.checkOnce(), config.egressWatchMinutes * 60_000);
watchTimer.unref();

const shutdown = async () => {
  clearInterval(purge);
  clearInterval(watchTimer);
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen({ host: config.host, port: config.port }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
