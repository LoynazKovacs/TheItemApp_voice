export interface WhisperClientOptions {
  baseUrl: string;
  timeoutMs: number;
}

export interface TranscribeOptions {
  language?: string;
  task?: 'transcribe' | 'translate';
  output?: 'txt' | 'json' | 'vtt' | 'srt' | 'tsv';
}

/**
 * Thin client around openai-whisper-asr-webservice (or faster-whisper-server),
 * which exposes a multipart POST /asr endpoint.
 */
export class WhisperClient {
  constructor(private readonly options: WhisperClientOptions) {}

  async getHealth(): Promise<{ ok: boolean; status: number; error?: string }> {
    try {
      const response = await this.fetchWithTimeout('/docs', { method: 'GET' });
      return { ok: response.ok, status: response.status, error: response.ok ? undefined : `Upstream HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async transcribe(
    buffer: Buffer,
    opts: { filename: string; mimeType: string } & TranscribeOptions,
  ): Promise<{ text: string; raw: unknown }> {
    const params = new URLSearchParams();
    params.set('output', opts.output ?? 'json');
    params.set('task', opts.task ?? 'transcribe');
    if (opts.language) params.set('language', opts.language);
    params.set('encode', 'true');

    const form = new FormData();
    form.append(
      'audio_file',
      new Blob([new Uint8Array(buffer)], { type: opts.mimeType || 'application/octet-stream' }),
      opts.filename || 'audio.webm',
    );

    const response = await this.fetchWithTimeout(`/asr?${params.toString()}`, {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[WhisperClient] ${response.status}: ${text.slice(0, 500)}`);
    }

    // The webservice claims `output=json` returns JSON, but the response
    // content-type is often `text/plain` regardless. Try to parse the body as
    // JSON first; fall back to plain text only if that fails.
    const body = await response.text();
    const trimmed = body.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const data = JSON.parse(trimmed) as { text?: unknown };
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        return { text, raw: data };
      } catch {
        /* fall through to plain-text handling */
      }
    }
    return { text: trimmed, raw: { text: trimmed } };
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
