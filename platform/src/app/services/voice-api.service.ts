import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type VoiceInfo = Readonly<{
  id: string;
  name?: string;
  language?: string;
  gender?: string;
}>;

export type TtsRequest = Readonly<{
  text: string;
  voice?: string;
  model?: string;
  format?: 'mp3' | 'wav' | 'opus' | 'flac' | 'aac' | 'pcm';
  speed?: number;
}>;

export type SttResult = Readonly<{
  ok: boolean;
  text?: string;
  language?: string;
  durationMs?: number;
  error?: string;
}>;

/**
 * Service for talking to /voice-api endpoints.
 *
 * Uses Angular HttpClient (not raw fetch) so the host's authInterceptor attaches
 * the in-memory access token automatically — federated remotes can't read the
 * `access_token` cookie because it's not always set (some sameSite/domain combos
 * drop the cookie even though httpOnly:false). HttpClient is shared via Native
 * Federation `singleton: true` so the host interceptor fires for our requests.
 */
@Injectable({ providedIn: 'root' })
export class VoiceApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = '/voice-api';

  async health(): Promise<{ ok: boolean; upstreams?: any; error?: string }> {
    try {
      return await firstValueFrom(
        this.http.get<{ ok: boolean; upstreams?: any; error?: string }>(`${this.baseUrl}/api/upstreams/health`),
      );
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listVoices(): Promise<{ ok: boolean; voices: VoiceInfo[]; error?: string }> {
    try {
      return await firstValueFrom(
        this.http.get<{ ok: boolean; voices: VoiceInfo[]; error?: string }>(`${this.baseUrl}/api/voices`),
      );
    } catch (err) {
      return { ok: false, voices: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** TTS — returns a Blob (audio/<format>) on success. */
  async tts(req: TtsRequest): Promise<{ ok: true; blob: Blob; mime: string } | { ok: false; error: string }> {
    try {
      const res = await firstValueFrom(
        this.http.post(`${this.baseUrl}/api/tts`, req, {
          observe: 'response',
          responseType: 'blob',
        }),
      );
      const blob = res.body ?? new Blob();
      const mime = res.headers.get('content-type') || 'audio/mpeg';
      return { ok: true, blob, mime };
    } catch (err: any) {
      // HttpErrorResponse carries the response body either as a parsed JSON object
      // or as a Blob (because we requested responseType: 'blob'). Surface whatever
      // text we can extract so the UI shows a useful error.
      let detail = '';
      if (err?.error instanceof Blob) {
        try { detail = await err.error.text(); } catch { /* ignore */ }
      } else if (typeof err?.error === 'string') {
        detail = err.error;
      } else if (err?.error?.error) {
        detail = err.error.error;
      } else if (err instanceof Error) {
        detail = err.message;
      }
      return { ok: false, error: `TTS failed: ${err?.status ?? ''} ${detail || ''}`.trim() };
    }
  }

  /** STT — POSTs a multipart form with the audio blob. */
  async stt(audio: Blob, opts: { language?: string; task?: 'transcribe' | 'translate'; filename?: string } = {}): Promise<SttResult> {
    try {
      const form = new FormData();
      form.append('audio', audio, opts.filename || 'recording.webm');
      if (opts.language) form.append('language', opts.language);
      if (opts.task) form.append('task', opts.task);
      // Let the browser set the multipart boundary by leaving Content-Type unset.
      const res = await firstValueFrom(this.http.post<SttResult>(`${this.baseUrl}/api/stt`, form));
      return res;
    } catch (err: any) {
      const detail = err?.error?.error || err?.error?.message || (err instanceof Error ? err.message : 'STT failed');
      return { ok: false, error: detail };
    }
  }
}
