import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { KokoroClient, type SpeechRequest } from './kokoroClient.js';
import { WhisperClient } from './whisperClient.js';
import { CoreApiClient } from './coreApiClient.js';
import { SeedRegistry } from './seedRegistry.js';
import type { AppConfig } from './config.js';

interface RouteDeps {
  config: AppConfig;
  kokoroClient: KokoroClient;
  whisperClient: WhisperClient;
  coreApi: CoreApiClient;
  seedRegistry: SeedRegistry;
}

function createAuthPreHandler(coreApi: CoreApiClient) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authorization = authorizationHeader(request.headers.authorization);
    const cookie = cookieHeader(request.headers.cookie);
    if (!authorization && !cookie) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
    const valid = await coreApi.verifyAuth(authorization, cookie);
    if (!valid) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
  };
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const requireAuth = createAuthPreHandler(deps.coreApi);

  app.get('/api/health', async () => ({
    ok: true,
    app: 'voice-api',
  }));

  app.get('/api/upstreams/health', async (_request, reply) => {
    const [tts, stt] = await Promise.all([
      deps.kokoroClient.getHealth(),
      deps.whisperClient.getHealth(),
    ]);
    return reply.send({
      ok: tts.ok && stt.ok,
      upstreams: {
        tts: { ok: tts.ok, status: tts.status, error: tts.error },
        stt: { ok: stt.ok, status: stt.status, error: stt.error },
      },
    });
  });

  app.get('/api/voices', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { voices } = await deps.kokoroClient.listVoices();
      return reply.send({ ok: true, voices });
    } catch (error) {
      request.log.warn({ error }, 'Failed to list voices');
      return reply.code(502).send({ ok: false, error: 'Unable to fetch voice list', voices: [] });
    }
  });

  // ---------------------------------------------------------------------------
  // Text → speech
  // ---------------------------------------------------------------------------
  app.post('/api/tts', { preHandler: requireAuth }, async (request, reply) => {
    const body = (request.body || {}) as Partial<SpeechRequest> & {
      text?: string;
    };
    const input = (typeof body.input === 'string' ? body.input : body.text) || '';
    if (!input.trim()) {
      return reply.code(400).send({ error: 'input (or text) is required' });
    }

    const responseFormat = (body.response_format as SpeechRequest['response_format']) || 'mp3';

    try {
      const upstream = await deps.kokoroClient.speech({
        input,
        voice: body.voice || deps.config.defaultVoice,
        model: body.model || deps.config.defaultModel,
        response_format: responseFormat,
        speed: typeof body.speed === 'number' ? body.speed : 1,
        stream: Boolean(body.stream),
      });
      if (!upstream.ok) {
        const errText = await upstream.text();
        request.log.warn({ status: upstream.status, errText: errText.slice(0, 500) }, 'Kokoro speech failed');
        return reply.code(upstream.status).send({ error: 'TTS upstream failure', detail: errText.slice(0, 500) });
      }
      const contentType = upstream.headers.get('content-type') || mimeForFormat(responseFormat);
      reply.header('content-type', contentType);
      reply.header('cache-control', 'no-store');
      const buffer = Buffer.from(await upstream.arrayBuffer());
      return reply.send(buffer);
    } catch (error) {
      request.log.error({ error }, 'TTS request failed');
      return reply.code(502).send({ error: 'TTS upstream unreachable' });
    }
  });

  // ---------------------------------------------------------------------------
  // Speech → text
  // ---------------------------------------------------------------------------
  app.post('/api/stt', { preHandler: requireAuth }, async (request, reply) => {
    if (!request.isMultipart || !request.isMultipart()) {
      return reply.code(400).send({ error: 'Expected multipart/form-data with an "audio" file field' });
    }
    const parts = request.parts();
    let language: string | undefined;
    let task: 'transcribe' | 'translate' = 'transcribe';
    let fileBuffer: Buffer | null = null;
    let fileName = 'audio.webm';
    let fileMime = 'audio/webm';

    try {
      for await (const part of parts) {
        if (part.type === 'file') {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) chunks.push(chunk as Buffer);
          fileBuffer = Buffer.concat(chunks);
          fileName = part.filename || fileName;
          fileMime = part.mimetype || fileMime;
        } else if (part.type === 'field') {
          if (part.fieldname === 'language' && typeof part.value === 'string') language = part.value;
          if (part.fieldname === 'task' && (part.value === 'transcribe' || part.value === 'translate')) task = part.value;
        }
      }
    } catch (error) {
      request.log.warn({ error }, 'Failed to read multipart body');
      return reply.code(400).send({ error: 'Failed to read multipart body' });
    }

    if (!fileBuffer) {
      return reply.code(400).send({ error: 'Missing audio file' });
    }

    try {
      const result = await deps.whisperClient.transcribe(fileBuffer, {
        filename: fileName,
        mimeType: fileMime,
        language,
        task,
        output: 'json',
      });
      return reply.send({ ok: true, text: result.text, raw: result.raw });
    } catch (error) {
      request.log.error({ error }, 'STT request failed');
      return reply.code(502).send({ ok: false, error: 'STT upstream failure' });
    }
  });

}

function mimeForFormat(format: string): string {
  switch (format) {
    case 'mp3': return 'audio/mpeg';
    case 'wav': return 'audio/wav';
    case 'opus': return 'audio/ogg';
    case 'flac': return 'audio/flac';
    case 'aac': return 'audio/aac';
    case 'pcm': return 'audio/L16';
    default: return 'application/octet-stream';
  }
}

function authorizationHeader(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
    return typeof first === 'string' ? first.trim() : undefined;
  }
  return undefined;
}

function cookieHeader(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}
