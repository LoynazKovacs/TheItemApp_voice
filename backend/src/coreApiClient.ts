export class CoreApiError extends Error {
  public readonly status: number;
  public readonly method: string;
  public readonly url: string;
  public readonly body: string;

  constructor(method: string, url: string, status: number, body: string) {
    super(`[coreApi] ${method} ${url} failed: ${status} — ${body}`);
    this.name = 'CoreApiError';
    this.method = method;
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

export type CoreApiConfig = {
  baseUrl: string;
  apiKey: string | null;
};

export interface VoiceVoiceRow {
  _id: string;
  key?: string;
  displayName?: string;
  profileId?: string;
  /** Drift marker: `audioFileId` that produced the current `profileId`. */
  provisionedFromAudioFileId?: string;
  /** Drift marker: `refText` that produced the current `profileId`. */
  provisionedFromRefText?: string;
  audioFileId?: string | { _id?: string } | null;
  refText?: string;
  language?: string;
  enabled?: boolean;
  [k: string]: unknown;
}

export interface FileMeta {
  _id: string;
  originalName?: string;
  mimeType?: string;
}

export interface FileBlob {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}

export class CoreApiClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: CoreApiConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
      'x-theitemapp-skip-webhooks': '1',
    };
  }

  updateApiKey(apiKey: string): void {
    this.headers['x-api-key'] = apiKey;
  }

  hasApiKey(): boolean {
    return typeof this.headers['x-api-key'] === 'string' && this.headers['x-api-key'].length > 0;
  }

  async verifyAuth(authorization?: string, cookie?: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/auth/me`, {
        method: 'GET',
        headers: this.requestHeaders(authorization, cookie),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * List voice_voices rows. x-ref fields (audioFileId) come back populated as
   * `{_id, ...}` objects; `extractFileId` in the reconciler handles both shapes.
   *
   * Note: do NOT add `populate=false` — the dynamic API's list handler treats
   * unknown query params as field filters, so `populate=false` becomes a
   * literal `{populate: "false"}` predicate and returns zero rows.
   */
  async listVoiceVoices(): Promise<VoiceVoiceRow[]> {
    const url = `${this.baseUrl}/api/dynamic/voice_voices?_l=500`;
    const res = await fetch(url, { method: 'GET', headers: this.headers });
    if (!res.ok) {
      const body = await res.text();
      throw new CoreApiError('GET', url, res.status, body.slice(0, 500));
    }
    const data = await res.json();
    return Array.isArray(data) ? (data as VoiceVoiceRow[]) : [];
  }

  /**
   * Patch a voice_voices row. Uses `$set` to avoid the platform validation
   * issues that bare-body patches can hit (see project memory).
   */
  async patchVoiceVoice(id: string, patch: Record<string, unknown>): Promise<void> {
    const url = `${this.baseUrl}/api/dynamic/voice_voices/${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ $set: patch }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new CoreApiError('PUT', url, res.status, body.slice(0, 500));
    }
  }

  /**
   * Stream a `files` record's bytes into memory. Voice reference WAVs are small
   * (a few hundred KB), so buffering the whole blob is fine here.
   */
  async downloadFile(fileId: string): Promise<FileBlob> {
    const metaUrl = `${this.baseUrl}/api/dynamic/files/${encodeURIComponent(fileId)}`;
    const metaRes = await fetch(metaUrl, { method: 'GET', headers: this.headers });
    if (!metaRes.ok) {
      const body = await metaRes.text();
      throw new CoreApiError('GET', metaUrl, metaRes.status, body.slice(0, 500));
    }
    const meta = (await metaRes.json()) as FileMeta | null;
    const mimeType = (meta?.mimeType ?? '').trim() || 'application/octet-stream';
    const filename = (meta?.originalName ?? '').trim() || `${fileId}.bin`;

    const contentUrl = `${this.baseUrl}/api/files/${encodeURIComponent(fileId)}/content`;
    const contentRes = await fetch(contentUrl, { method: 'GET', headers: this.headers });
    if (!contentRes.ok) {
      const body = await contentRes.text();
      throw new CoreApiError('GET', contentUrl, contentRes.status, body.slice(0, 500));
    }
    const buf = new Uint8Array(await contentRes.arrayBuffer());
    return { bytes: buf, mimeType, filename };
  }

  private requestHeaders(authorization?: string, cookie?: string): Record<string, string> {
    const header = typeof authorization === 'string' && authorization.trim().length > 0 ? authorization.trim() : '';
    const cookieHeader = typeof cookie === 'string' && cookie.trim().length > 0 ? cookie.trim() : '';
    return {
      ...this.headers,
      ...(header ? { Authorization: header } : {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    };
  }
}
