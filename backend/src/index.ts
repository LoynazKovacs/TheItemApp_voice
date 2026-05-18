import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { getConfig } from './config.js';
import { KokoroClient } from './kokoroClient.js';
import { WhisperClient } from './whisperClient.js';
import { registerRoutes } from './routes.js';
import { loadSeedRegistry } from './seedRegistry.js';
import { CoreApiClient } from './coreApiClient.js';

async function main(): Promise<void> {
  const config = getConfig();

  const app = Fastify({
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
    },
    bodyLimit: 50 * 1024 * 1024,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  });

  const kokoroClient = new KokoroClient({
    baseUrl: config.kokoroBaseUrl,
    timeoutMs: config.upstreamTimeoutMs,
  });
  const whisperClient = new WhisperClient({
    baseUrl: config.whisperBaseUrl,
    timeoutMs: config.upstreamTimeoutMs,
  });

  const coreApi = new CoreApiClient({
    baseUrl: config.coreApiUrl,
    apiKey: config.coreApiKey,
  });

  const seedRegistry = loadSeedRegistry();
  const appManifest = seedRegistry.manifest;

  registerRoutes(app, {
    config,
    kokoroClient,
    whisperClient,
    coreApi,
    seedRegistry,
  });

  if (appManifest) {
    app.log.info(
      {
        appKey: (appManifest.appKey as string | undefined) ?? config.appKey,
        collections: seedRegistry.listCollections().length,
      },
      'Seed data loaded',
    );
  } else {
    app.log.warn('No dbseed manifest found. App registration and seed endpoints will return empty data.');
  }

  app.get('/app/health', async () => ({
    ok: true,
    appKey: (appManifest?.appKey as string | undefined) ?? config.appKey,
    version: (appManifest?.appVersion as string | undefined) ?? '0.0.0',
  }));

  app.get('/app/manifest', async () => appManifest ?? {});
  app.get('/app/seeds', async () => ({ collections: seedRegistry.listCollections() }));
  app.get('/app/seeds/:collection', async (request, reply) => {
    const { collection } = request.params as { collection: string };
    const data = seedRegistry.getCollection(collection);
    if (!data) {
      return reply.code(404).send({ error: `No seed data for: ${collection}` });
    }
    return reply.send(data);
  });

  const registerOnce = async (): Promise<boolean> => {
    if (!appManifest) return false;
    try {
      app.log.info({ coreApiUrl: config.coreApiUrl }, 'Attempting registration');
      const response = await fetch(`${config.coreApiUrl}/api/apps/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.appRegistrationKey ? { 'X-Registration-Key': config.appRegistrationKey } : {}),
        },
        body: JSON.stringify({ manifest: appManifest, baseUrl: config.registrationBaseUrl }),
      });
      if (!response.ok) {
        const errorBody = await response.text();
        app.log.warn({ status: response.status, body: errorBody }, 'Registration failed');
        return false;
      }
      const data = await response.json() as any;
      app.log.info('Registered with core');
      if (data.apiKey) {
        coreApi.updateApiKey(data.apiKey);
        app.log.info('Core API client updated with auto-provisioned API key');
      } else {
        app.log.warn({ data }, 'No apiKey returned from core registration!');
      }
      return true;
    } catch (error) {
      app.log.warn({ error }, 'Registration request failed');
      return false;
    }
  };

  app.post('/app/re-register', async () => {
    setImmediate(() => {
      registerOnce().catch(() => {
        // Best effort; details are logged by registerOnce.
      });
    });
    return { ok: true, appKey: (appManifest?.appKey as string | undefined) ?? config.appKey };
  });

  await app.listen({ host: '0.0.0.0', port: config.port });
  app.log.info(`Voice API listening on http://localhost:${config.port}`);

  const heartbeatTimer = setInterval(() => {
    if (!appManifest) return;
    void registerOnce();
  }, config.registrationHeartbeatMs);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeatTimer);
    try {
      await fetch(`${config.coreApiUrl}/api/apps/register/${config.appKey}`, {
        method: 'DELETE',
        headers: {
          ...(config.appRegistrationKey ? { 'X-Registration-Key': config.appRegistrationKey } : {}),
        },
      });
      app.log.info('Deregistered from core');
    } catch {
      // Best-effort on shutdown.
    }
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (appManifest) {
    void (async () => {
      const maxRetries = 30;
      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        const ok = await registerOnce();
        if (ok) return;
        app.log.info({ attempt, maxRetries }, 'Core not ready, retrying registration');
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      app.log.error('Failed to register with core after all retries');
    })();
  }
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
