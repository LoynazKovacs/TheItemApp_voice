import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import {
  startAppRegistration,
  type AppManifest,
  type RegistrationHandle,
} from '@loynazkovacs/theitemapp-backend-sdk';
import { getConfig } from './config.js';
import { OmniVoiceClient } from './omnivoiceClient.js';
import { registerRoutes } from './routes.js';
import { loadSeedRegistry } from './seedRegistry.js';
import { CoreApiClient } from './coreApiClient.js';
import { VoiceProfileReconciler } from './voiceProfileReconciler.js';

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
    // 500 MB — enough headroom for short videos dropped into the dictaphone's
    // import zone (the transcoder strips video out, but the upload itself
    // still pushes the original bytes).
    bodyLimit: 500 * 1024 * 1024,
  });

  await app.register(cors, { origin: false });
  await app.register(multipart, {
    limits: { fileSize: 500 * 1024 * 1024, files: 1 },
  });

  const omnivoiceClient = new OmniVoiceClient({
    baseUrl: config.omnivoiceBaseUrl,
    timeoutMs: config.upstreamTimeoutMs,
  });

  const coreApi = new CoreApiClient({
    baseUrl: config.coreApiUrl,
    apiKey: config.coreApiKey,
  });

  const seedRegistry = loadSeedRegistry();
  const appManifest = seedRegistry.manifest;

  const reconciler = new VoiceProfileReconciler({
    coreApi,
    omnivoice: omnivoiceClient,
    logger: app.log,
  });

  registerRoutes(app, {
    config,
    omnivoiceClient,
    coreApi,
    seedRegistry,
    reconciler,
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

  // Registration lifecycle (register-with-retry, auto-provisioned API key
  // capture, /app/re-register, heartbeat, deregister) is provided by the shared
  // backend SDK. Assigned after `listen` below; the route closure reads it at
  // call time.
  let registration: RegistrationHandle | null = null;

  app.post('/app/re-register', async () => {
    registration?.reRegister();
    return { ok: true, appKey: (appManifest?.appKey as string | undefined) ?? config.appKey };
  });

  await app.listen({ host: '0.0.0.0', port: config.port });
  app.log.info(`Voice API listening on http://localhost:${config.port}`);

  // Start the reconciler immediately; it gates internally on `hasApiKey()` so
  // it stays a no-op until registration succeeds.
  reconciler.start();

  if (appManifest) {
    registration = startAppRegistration({
      coreUrl: config.coreApiUrl,
      manifest: appManifest as unknown as AppManifest,
      selfUrl: config.registrationBaseUrl,
      registrationKey: config.appRegistrationKey,
      heartbeatMs: config.registrationHeartbeatMs,
      // Keep our own signal handlers so the reconciler + Fastify shut down
      // cleanly before we deregister.
      installSignalHandlers: false,
      onApiKey: (key) => {
        coreApi.updateApiKey(key);
        app.log.info('Core API client updated with auto-provisioned API key');
        // Now that we can authenticate, kick the voice-profile reconciler so any
        // freshly-installed voice_voices rows get their OmniVoice profiles ASAP.
        reconciler.requestSweep();
      },
      logger: {
        info: (m) => app.log.info(m),
        warn: (m) => app.log.warn(m),
        error: (m) => app.log.error(m),
      },
    });
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    reconciler.stop();
    registration?.stop();
    await registration?.deregister();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
