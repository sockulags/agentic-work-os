#!/usr/bin/env node
import { loadConfig } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { HarnessServer } from './server.js';
import { createLogger } from './util/logger.js';

const log = createLogger('main');

async function main(): Promise<void> {
  const config = loadConfig();
  const orchestrator = new Orchestrator(config);
  await orchestrator.start();

  const server = new HarnessServer(config, orchestrator);
  const port = await server.listen();

  /**
   * The one line that goes to stdout, in a fixed machine-readable shape.
   *
   * The Tauri shell parses this to learn the port and token, so its format is a
   * contract — see apps/desktop/src-tauri/src/main.rs.
   */
  process.stdout.write(
    `${JSON.stringify({ awos: 'ready', host: config.host, port, token: server.token })}\n`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    // Order matters: close the socket first so no new turn starts, then stop the agents
    // so each one gets its grace period to exit cleanly.
    await server.close();
    await orchestrator.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Losing the parent means the desktop shell is gone; don't leave agents orphaned.
  process.stdin.on('end', () => void shutdown('stdin-close'));
}

main().catch((err: Error) => {
  log.error('fatal', { message: err.message, stack: err.stack });
  process.exit(1);
});
