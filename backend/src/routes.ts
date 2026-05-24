import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { OmniVoiceClient, type SpeechRequest } from './omnivoiceClient.js';
import { CoreApiClient } from './coreApiClient.js';
import { SeedRegistry } from './seedRegistry.js';
import type { VoiceProfileReconciler } from './voiceProfileReconciler.js';
import type { AppConfig } from './config.js';
import { transcodeToWav } from './mediaTranscoder.js';

interface RouteDeps {
  config: AppConfig;
  omnivoiceClient: OmniVoiceClient;
  coreApi: CoreApiClient;
  seedRegistry: SeedRegistry;
  reconciler: VoiceProfileReconciler;
}

/** "users" group — voice-backend functional user is a member, so adding this
 *  to a file's groupIds lets the reconciler read the bytes. */
const VOICE_BACKEND_GROUP_ID = '7000000000000000001d0002';

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
    const omni = await deps.omnivoiceClient.getHealth();
    return reply.send({
      ok: omni.ok,
      upstreams: {
        omnivoice: { ok: omni.ok, status: omni.status, error: omni.error },
        // Back-compat aliases for any UI still keyed on tts/stt.
        tts: { ok: omni.ok, status: omni.status, error: omni.error },
        stt: { ok: omni.ok, status: omni.status, error: omni.error },
      },
    });
  });

  app.get('/api/voices', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const { voices } = await deps.omnivoiceClient.listVoices();
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
      const upstream = await deps.omnivoiceClient.speech({
        input,
        voice: body.voice || deps.config.defaultVoice,
        model: body.model || deps.config.defaultModel,
        response_format: responseFormat,
        speed: typeof body.speed === 'number' ? body.speed : 1,
        stream: Boolean(body.stream),
      });
      if (!upstream.ok) {
        const errText = await upstream.text();
        request.log.warn({ status: upstream.status, errText: errText.slice(0, 500) }, 'OmniVoice speech failed');
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

    // Normalize through ffmpeg → 24 kHz mono PCM WAV before forwarding to
    // omnivoice. The browser's MediaRecorder occasionally produces truncated
    // webm payloads (EBML header but no audio cluster) when the user releases
    // the push-to-talk button before the muxer flushes a cluster — libav
    // inside omnivoice rejects those with EOFError. ffmpeg is permissive and
    // can salvage any decodable audio, so transcoding here turns a hard
    // failure into either a successful transcription or a clean
    // "no audio captured" 400.
    let wavBuffer: Buffer;
    let wavFilename = replaceExt(fileName, 'wav');
    try {
      const out = await transcodeToWav(fileBuffer);
      wavBuffer = out.wav;
      if (out.durationS !== null && out.durationS < 0.1) {
        return reply.code(400).send({ ok: false, error: 'Recording too short — no audio captured.' });
      }
    } catch (error) {
      request.log.warn({
        err: error,
        errorMessage: error instanceof Error ? error.message : String(error),
        fileMime,
        bytes: fileBuffer.length,
      }, 'STT input transcode failed');
      return reply.code(400).send({
        ok: false,
        error: 'Could not decode the recorded audio. Try recording again.',
      });
    }

    try {
      const result = await deps.omnivoiceClient.transcribe(wavBuffer, {
        filename: wavFilename,
        mimeType: 'audio/wav',
        language,
        task,
      });
      return reply.send({
        ok: true,
        text: result.text,
        language: result.language,
        segments: result.segments,
        durationS: result.durationS,
        transcriptionTimeS: result.transcriptionTimeS,
        engine: result.engine,
        raw: result.raw,
      });
    } catch (error) {
      request.log.error({ error }, 'STT request failed');
      return reply.code(502).send({ ok: false, error: 'STT upstream failure' });
    }
  });

  // ---------------------------------------------------------------------------
  // Drop any media file (audio or video, any codec) → transcode to WAV via
  // ffmpeg → run STT → upload the WAV to core → create a voice_notes row.
  //
  // Used by the dictaphone prefab's drag-and-drop zone. Each request handles
  // exactly one file; the frontend loops for batch drops.
  // ---------------------------------------------------------------------------
  app.post('/api/import-media', { preHandler: requireAuth }, async (request, reply) => {
    if (!request.isMultipart || !request.isMultipart()) {
      return reply.code(400).send({ error: 'Expected multipart/form-data with a "file" field' });
    }

    let language: string | undefined;
    let originalFilename = 'upload.bin';
    let originalMime = 'application/octet-stream';
    let inputBuffer: Buffer | null = null;
    let titleOverride: string | undefined;

    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) chunks.push(chunk as Buffer);
          inputBuffer = Buffer.concat(chunks);
          originalFilename = part.filename || originalFilename;
          originalMime = part.mimetype || originalMime;
        } else if (part.type === 'field') {
          if (part.fieldname === 'language' && typeof part.value === 'string') language = part.value;
          if (part.fieldname === 'title' && typeof part.value === 'string') titleOverride = part.value;
        }
      }
    } catch (error) {
      request.log.warn({ error }, 'Failed to read import-media multipart body');
      return reply.code(400).send({ error: 'Failed to read multipart body' });
    }

    if (!inputBuffer || inputBuffer.length === 0) {
      return reply.code(400).send({ error: 'Missing file' });
    }

    // 1. Transcode via ffmpeg → 24 kHz mono PCM WAV in memory.
    let wavBuffer: Buffer;
    let durationS: number | null = null;
    try {
      const out = await transcodeToWav(inputBuffer);
      wavBuffer = out.wav;
      durationS = out.durationS;
    } catch (error) {
      // Pino swallows generic-prop Error objects — use `err` to fire its
      // built-in serializer + log message string explicitly so we don't have
      // to dig through Error.toString() output.
      request.log.warn({
        err: error,
        errorMessage: error instanceof Error ? error.message : String(error),
        originalMime,
        bytes: inputBuffer.length,
      }, 'ffmpeg transcode failed');
      return reply.code(400).send({
        ok: false,
        error: 'Could not decode the uploaded file. Make sure it is a supported audio or video format.',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    // 2. Run STT on the WAV via OmniVoice.
    let transcript = '';
    let detectedLanguage: string | undefined = language;
    try {
      const sttRes = await deps.omnivoiceClient.transcribe(wavBuffer, {
        filename: replaceExt(originalFilename, 'wav'),
        mimeType: 'audio/wav',
        language,
        task: 'transcribe',
      });
      transcript = (sttRes.text || '').trim();
      if (sttRes.language) detectedLanguage = sttRes.language;
    } catch (error) {
      // STT failure is not fatal — we still save the note so the user keeps
      // the WAV and can re-run transcription later.
      request.log.warn({ error }, 'STT failed during media import (continuing without transcript)');
    }

    // 3. Upload the WAV to core under the caller's auth so they own the file.
    const authorization = authorizationHeader(request.headers.authorization);
    const cookie = cookieHeader(request.headers.cookie);
    const baseTitle = titleOverride?.trim() || stripExt(originalFilename) || 'Imported voice note';
    const wavName = `${stripExt(originalFilename) || 'voice-note'}.wav`;

    let fileId: string;
    try {
      const uploaded = await deps.coreApi.uploadFile(
        { bytes: new Uint8Array(wavBuffer), mimeType: 'audio/wav', filename: wavName },
        { title: baseTitle, visibility: 'private' },
        authorization,
        cookie,
      );
      fileId = uploaded._id;
    } catch (error) {
      request.log.error({ error }, 'Failed to upload converted WAV to core');
      return reply.code(502).send({
        ok: false,
        error: 'Could not upload the converted audio. Try again.',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    // 4. Create the voice_notes row.
    let noteId: string;
    try {
      const created = await deps.coreApi.createVoiceNote(
        {
          title: baseTitle,
          audioFileId: fileId,
          transcript,
          ...(detectedLanguage ? { language: detectedLanguage } : {}),
          ...(typeof durationS === 'number' && Number.isFinite(durationS)
            ? { durationMs: Math.round(durationS * 1000) }
            : {}),
          mimeType: 'audio/wav',
        },
        authorization,
        cookie,
      );
      noteId = created._id;
    } catch (error) {
      request.log.error({ error, fileId }, 'Failed to create voice_notes row');
      return reply.code(502).send({
        ok: false,
        error: 'Saved the audio but could not create the note. Check Voice notes manually.',
        detail: error instanceof Error ? error.message : String(error),
        fileId,
      });
    }

    return reply.send({
      ok: true,
      noteId,
      fileId,
      title: baseTitle,
      transcript,
      language: detectedLanguage ?? null,
      durationMs: typeof durationS === 'number' ? Math.round(durationS * 1000) : null,
      originalFilename,
      originalMime,
    });
  });

  // ---------------------------------------------------------------------------
  // Create a voice_voices row from an existing voice_notes row.
  //
  // Backs the "Create voice" row-button on the voice_notes data model. Does
  // three things atomically-ish:
  //   1. Reads the voice_notes row.
  //   2. Widens the underlying file's `groupIds` so the voice-backend
  //      functional user can read it (uploadDirect leaves groupIds=[] which
  //      blocks the reconciler at the row-security layer). Patched under the
  //      caller's auth — they own the file, so they can edit it.
  //   3. Creates a voice_voices row with derived `displayName`/`key`/`refText`
  //      /`language`/`audioFileId` and kicks the reconciler to provision the
  //      OmniVoice profile.
  // ---------------------------------------------------------------------------
  app.post('/api/voice-from-note/:noteId', { preHandler: requireAuth }, async (request, reply) => {
    const { noteId } = request.params as { noteId?: string };
    if (!noteId || !/^[0-9a-f]{24}$/i.test(noteId)) {
      return reply.code(400).send({ error: 'Invalid noteId' });
    }

    try {
      const note = await deps.coreApi.getVoiceNote(noteId);
      if (!note) return reply.code(404).send({ error: 'Voice note not found' });

      const audioFileId = extractFileId(note.audioFileId);
      if (!audioFileId) {
        return reply.code(422).send({ error: 'Voice note has no audioFileId' });
      }
      const transcript = typeof note.transcript === 'string' ? note.transcript.trim() : '';
      if (!transcript) {
        return reply.code(422).send({ error: 'Voice note has no transcript — required as the reference text' });
      }

      // Forward caller auth so the file-row groupIds patch passes the
      // owner-only RBAC on files uploaded via uploadDirect.
      const authorization = authorizationHeader(request.headers.authorization);
      const cookie = cookieHeader(request.headers.cookie);

      // Read current groupIds first so we add (rather than replace) ours.
      const fileMeta = await deps.coreApi.getFileMeta(audioFileId);
      const existingGroupIds = Array.isArray(fileMeta?.groupIds) ? fileMeta.groupIds : [];
      if (!existingGroupIds.includes(VOICE_BACKEND_GROUP_ID)) {
        const widened = [...existingGroupIds, VOICE_BACKEND_GROUP_ID];
        try {
          await deps.coreApi.patchFileGroupIds(audioFileId, widened, authorization, cookie);
        } catch (err) {
          request.log.warn({ err, audioFileId }, 'Failed to widen file groupIds (proceeding anyway)');
        }
      }

      const title = (typeof note.title === 'string' && note.title.trim()) || `Voice ${noteId.slice(-6)}`;
      const slug = slugify(title) || `voice-${noteId.slice(-6)}`;
      const key = `${slug}-${noteId.slice(-6)}`;
      const language = typeof note.language === 'string' && note.language.trim()
        ? note.language.trim()
        : 'Auto';

      const created = await deps.coreApi.createVoiceVoice({
        key,
        displayName: title,
        audioFileId,
        refText: transcript,
        language,
        enabled: true,
        groupIds: [VOICE_BACKEND_GROUP_ID],
      });

      // Provision the OmniVoice profile ASAP — without this the user has to
      // wait up to 30s for the next scheduled sweep.
      deps.reconciler.requestSweep();

      return reply.send({ ok: true, voiceVoiceId: created._id, key, displayName: title });
    } catch (error) {
      request.log.error({ error, noteId }, 'voice-from-note failed');
      const status = (error as { status?: number } | null)?.status;
      return reply
        .code(typeof status === 'number' && status >= 400 && status < 600 ? status : 500)
        .send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

}

/** Strip the file extension from a name (`audio.ogg` → `audio`). Returns the
 *  original input if no dot is found. */
function stripExt(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return name; // hidden files keep their dot prefix
  return name.slice(0, idx);
}

/** Replace the file extension of a name (`audio.ogg`, `wav` → `audio.wav`). */
function replaceExt(name: string, newExt: string): string {
  const base = stripExt(name);
  return `${base}.${newExt}`;
}

/** Convert a title to a stable lowercase ascii slug, max 40 chars. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Same shape-tolerant id extractor used in voiceProfileReconciler. */
function extractFileId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'object') {
    const id = (value as { _id?: unknown })._id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return null;
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
