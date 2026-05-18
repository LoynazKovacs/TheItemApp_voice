export interface KokoroClientOptions {
  baseUrl: string;
  timeoutMs: number;
}

export interface SpeechRequest {
  input: string;
  voice?: string;
  model?: string;
  response_format?: 'mp3' | 'wav' | 'opus' | 'flac' | 'aac' | 'pcm';
  speed?: number;
  stream?: boolean;
}

/**
 * Thin client around Kokoro-FastAPI, which exposes an OpenAI-compatible
 * audio API on /v1/audio/speech and /v1/audio/voices.
 */
export class KokoroClient {
  constructor(private readonly options: KokoroClientOptions) {}

  async getHealth(): Promise<{ ok: boolean; status: number; error?: string }> {
    try {
      const response = await this.fetchWithTimeout('/health', { method: 'GET' });
      if (response.ok) return { ok: true, status: response.status };
      // Fallback: voices listing is a reliable signal too.
      const fallback = await this.fetchWithTimeout('/v1/audio/voices', { method: 'GET' });
      return { ok: fallback.ok, status: fallback.status, error: fallback.ok ? undefined : `Upstream HTTP ${fallback.status}` };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Returns voices as plain objects so callers don't depend on Kokoro's wire shape. */
  async listVoices(): Promise<{ voices: Array<{ id: string; name: string }> }> {
    const response = await this.fetchWithTimeout('/v1/audio/voices', { method: 'GET' });
    const data = await this.safeJson(response) as { voices?: unknown };
    const raw = Array.isArray(data.voices) ? data.voices : [];
    const voices = raw
      .filter((v): v is string => typeof v === 'string')
      .map((id) => ({ id, name: id }));
    return { voices };
  }

  /** Returns the upstream Response so the caller can stream/forward audio bytes. */
  async speech(request: SpeechRequest): Promise<Response> {
    const body = {
      model: request.model ?? 'kokoro',
      input: request.input,
      voice: request.voice ?? 'af_sky',
      response_format: request.response_format ?? 'mp3',
      speed: typeof request.speed === 'number' ? request.speed : 1,
      stream: request.stream ?? false,
    };
    return this.fetchWithTimeout('/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async safeJson(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`[KokoroClient] ${response.status}: ${text.slice(0, 200)}`);
    }
    if (!text.trim()) return {};
    return JSON.parse(text) as Record<string, unknown>;
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
