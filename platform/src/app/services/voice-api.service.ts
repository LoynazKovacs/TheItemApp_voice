import { Injectable } from '@angular/core';

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

@Injectable({ providedIn: 'root' })
export class VoiceApiService {
  private readonly baseUrl = '/voice-api';

  async health(): Promise<{ ok: boolean; upstreams?: any; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/upstreams/health`, { headers: this.authHeaders() });
      return await res.json();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listVoices(): Promise<{ ok: boolean; voices: VoiceInfo[]; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/voices`, { headers: this.authHeaders() });
      return await res.json();
    } catch (err) {
      return { ok: false, voices: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** TTS — returns a Blob (audio/<format>) on success, throws on failure. */
  async tts(req: TtsRequest): Promise<{ ok: true; blob: Blob; mime: string } | { ok: false; error: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify(req),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const j = await res.json();
          detail = j.error || j.message || JSON.stringify(j);
        } catch {
          detail = await res.text().catch(() => '');
        }
        return { ok: false, error: `TTS failed: ${res.status} ${detail}` };
      }
      const mime = res.headers.get('content-type') || 'audio/mpeg';
      const blob = await res.blob();
      return { ok: true, blob, mime };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** STT — POSTs a multipart form with the audio blob. */
  async stt(audio: Blob, opts: { language?: string; task?: 'transcribe' | 'translate'; filename?: string } = {}): Promise<SttResult> {
    try {
      const form = new FormData();
      form.append('audio', audio, opts.filename || 'recording.webm');
      if (opts.language) form.append('language', opts.language);
      if (opts.task) form.append('task', opts.task);

      const res = await fetch(`${this.baseUrl}/api/stt`, {
        method: 'POST',
        headers: { ...this.authHeaders() },
        body: form,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        return { ok: false, error: json?.error || json?.message || `STT failed: ${res.status}` };
      }
      return json as SttResult;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private getAccessToken(): string | null {
    if (typeof document === 'undefined') return null;
    const match = document.cookie.match(/(?:^|;\s*)access_token=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  private authHeaders(): Record<string, string> {
    const t = this.getAccessToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }
}
