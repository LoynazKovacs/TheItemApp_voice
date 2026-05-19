export interface OmniVoiceClientOptions {
  baseUrl: string;
  timeoutMs: number;
}

export interface SpeechRequest {
  input: string;
  /** Maps to OmniVoice `profile_id` (voice profile UUID). */
  voice?: string;
  /** Reserved — OmniVoice picks its active TTS engine via /engines/select. Ignored here. */
  model?: string;
  /**
   * OmniVoice currently always emits WAV. We keep the field for forwards-compat
   * but the upstream response is `audio/wav` regardless of what is requested.
   */
  response_format?: 'mp3' | 'wav' | 'opus' | 'flac' | 'aac' | 'pcm';
  speed?: number;
  /** Not supported by /generate. Kept for API back-compat. */
  stream?: boolean;
  /** Language hint, e.g. "English", "Spanish", … */
  language?: string;
  /** Optional natural-language style instruction. */
  instruct?: string;
}

export interface TranscribeOptions {
  language?: string;
  task?: 'transcribe' | 'translate';
  /** OmniVoice ASR backend id (e.g. "whisperx", "faster-whisper", "pytorch-whisper"). */
  model?: string;
  /** OmniVoice transcription mode (engine-specific). */
  mode?: string;
}

export interface OmniVoiceTranscription {
  text: string;
  language?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  durationS?: number;
  transcriptionTimeS?: number;
  engine?: string;
  raw: unknown;
}

interface OmniVoiceProfile {
  id?: unknown;
  name?: unknown;
  language?: unknown;
}

/**
 * Thin client around OmniVoice-Studio's native HTTP API on port 3900.
 *
 * Endpoints used:
 *   GET  /health                 — service liveness
 *   GET  /profiles               — voice profiles (the user-facing "voices")
 *   POST /generate               — TTS, multipart in, raw audio/wav out
 *   POST /transcribe             — STT, multipart in, JSON out
 */
export class OmniVoiceClient {
  constructor(private readonly options: OmniVoiceClientOptions) {}

  async getHealth(): Promise<{ ok: boolean; status: number; error?: string }> {
    try {
      const response = await this.fetchWithTimeout('/health', { method: 'GET' });
      if (response.ok) return { ok: true, status: response.status };
      const fallback = await this.fetchWithTimeout('/profiles', { method: 'GET' });
      return { ok: fallback.ok, status: fallback.status, error: fallback.ok ? undefined : `Upstream HTTP ${fallback.status}` };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Returns voice profiles as plain `{id, name}` so callers don't depend on
   * OmniVoice's wire shape. OmniVoice exposes both user voice profiles
   * (`/profiles`) and a curated gallery (`/gallery/voices`); we surface
   * profiles since they're the ones used as `profile_id` on /generate.
   */
  async listVoices(): Promise<{ voices: Array<{ id: string; name: string }> }> {
    const response = await this.fetchWithTimeout('/profiles', { method: 'GET' });
    const data = await this.safeJson(response);
    const raw = Array.isArray(data) ? data : [];
    const voices: Array<{ id: string; name: string }> = [];
    for (const entry of raw as OmniVoiceProfile[]) {
      if (!entry || typeof entry !== 'object') continue;
      const id = typeof entry.id === 'string' ? entry.id : undefined;
      if (!id) continue;
      const name = typeof entry.name === 'string' ? entry.name : id;
      voices.push({ id, name });
    }
    return { voices };
  }

  /** Returns the upstream Response so the caller can stream/forward audio bytes. */
  async speech(request: SpeechRequest): Promise<Response> {
    const form = new FormData();
    form.append('text', request.input);
    if (request.language) form.append('language', request.language);
    if (request.voice) form.append('profile_id', request.voice);
    if (request.instruct) form.append('instruct', request.instruct);
    if (typeof request.speed === 'number') form.append('speed', String(request.speed));
    return this.fetchWithTimeout('/generate', {
      method: 'POST',
      body: form,
    });
  }

  async transcribe(
    buffer: Buffer,
    opts: { filename: string; mimeType: string } & TranscribeOptions,
  ): Promise<OmniVoiceTranscription> {
    const form = new FormData();
    form.append(
      'audio',
      new Blob([new Uint8Array(buffer)], { type: opts.mimeType || 'application/octet-stream' }),
      opts.filename || 'audio.webm',
    );
    if (opts.language) form.append('language', opts.language);
    if (opts.model) form.append('model', opts.model);
    if (opts.mode) form.append('mode', opts.mode);
    // OmniVoice has no built-in translate task on /transcribe; if the caller
    // asks to translate we still hit /transcribe and let the upstream decide
    // (most backends transcribe to source language; future-proofed via opts.mode).

    const response = await this.fetchWithTimeout('/transcribe', {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`[OmniVoiceClient] ${response.status}: ${errText.slice(0, 500)}`);
    }

    const bodyText = await response.text();
    const trimmed = bodyText.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const data = JSON.parse(trimmed) as Record<string, unknown>;
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        const language = typeof data.language === 'string' ? data.language : undefined;
        const segments = Array.isArray(data.segments)
          ? (data.segments as Array<Record<string, unknown>>)
              .map((s) => ({
                start: typeof s.start === 'number' ? s.start : 0,
                end: typeof s.end === 'number' ? s.end : 0,
                text: typeof s.text === 'string' ? s.text : '',
              }))
          : undefined;
        return {
          text,
          language,
          segments,
          durationS: typeof data.duration_s === 'number' ? data.duration_s : undefined,
          transcriptionTimeS: typeof data.transcription_time_s === 'number' ? data.transcription_time_s : undefined,
          engine: typeof data.engine === 'string' ? data.engine : undefined,
          raw: data,
        };
      } catch {
        /* fall through */
      }
    }
    return { text: trimmed, raw: { text: trimmed } };
  }

  private async safeJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`[OmniVoiceClient] ${response.status}: ${text.slice(0, 200)}`);
    }
    if (!text.trim()) return null;
    return JSON.parse(text) as unknown;
  }

  private async fetchWithTimeout(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      return await fetch(`${this.options.baseUrl}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
