import { buildApp } from './app';
import { env } from './config/env';

async function main() {
  const app = await buildApp();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down: draining in-flight requests');
    // Hard stop if draining hangs (K8s terminationGracePeriodSeconds is 30s by default).
    setTimeout(() => process.exit(1), 25_000).unref();
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => app.log.error({ err }, 'Unhandled promise rejection'));

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
