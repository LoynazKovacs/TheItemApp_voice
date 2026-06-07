/**
 * Core TheItemApp backend client for the voice app.
 *
 * Thin adapter over the shared backend SDK's `CoreApiClient` + `verifyUser`
 * helper. It preserves this app's conventions so NO call-sites change:
 *  - the app's method names + signatures (`listVoiceVoices` / `patchVoiceVoice`
 *    / `getVoiceNote` / `getFileMeta` / `createVoiceVoice` etc.) used by the
 *    routes and the voice-profile reconciler;
 *  - `$set`-wrapped updates (the platform validates bare-body patches poorly —
 *    see project memory);
 *  - default-populate `listVoiceVoices` (NO `populate` query param — the dynamic
 *    list handler would treat it as a field filter; the reconciler reads the
 *    populated `audioFileId` x-ref off these rows);
 *  - `verifyAuth` / `verifyAdmin` boolean helpers (delegating to the SDK's
 *    `verifyUser`) consumed by the routes' auth preHandlers;
 *  - `hasApiKey` (→ SDK `isReady`) gating the reconciler sweep.
 *
 * SDK gaps preserved with raw `fetch` (authenticated via `sdk.getApiKey()`):
 *  - `createVoiceNote`, `uploadFile`, `patchFileGroupIds` forward the END USER's
 *    `Authorization`/`Cookie` (so the file/note is owned by / editable by the
 *    caller, per files RBAC) WHILE still carrying the functional `x-api-key` +
 *    skip-webhooks header. The SDK's `updateAsUser` strips the functional key
 *    and supports neither cookie forwarding nor multipart upload, and there is
 *    no `createAsUser`/user-scoped `uploadFile`, so these keep raw requests.
 *  - `downloadFile` streams `files/:id/content` bytes — the SDK has no file
 *    download helper.
 *
 * The functional `x-api-key` is auto-provisioned by core and rotated on each
 * registration — see updateApiKey.
 */

import {
  CoreApiClient as SdkCoreApiClient,
  CoreApiError,
  verifyUser,
  type CoreApiConfig as SdkCoreApiConfig,
} from '@loynazkovacs/theitemapp-backend-sdk';

export { CoreApiError };

/** Platform Admins group — members may mutate the voice engine device/load. */
const ADMIN_GROUP_ID = '7000000000000000001d0001';

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
  /** Drift marker: deterministic seed pinned on the OmniVoice profile. */
  provisionedFromSeed?: number;
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
  groupIds?: string[];
}

export interface VoiceNoteRow {
  _id: string;
  title?: string;
  audioFileId?: string | { _id?: string } | null;
  transcript?: string;
  language?: string;
  groupIds?: string[];
  [k: string]: unknown;
}

export interface FileBlob {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}

export class CoreApiClient {
  private readonly sdk: SdkCoreApiClient;
  private readonly baseUrl: string;

  constructor(config: CoreApiConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.sdk = new SdkCoreApiClient({ baseUrl: config.baseUrl, apiKey: config.apiKey } as SdkCoreApiConfig);
  }

  updateApiKey(apiKey: string): void {
    this.sdk.updateApiKey(apiKey);
  }

  hasApiKey(): boolean {
    return this.sdk.isReady();
  }

  async verifyAuth(authorization?: string, cookie?: string): Promise<boolean> {
    try {
      return (await verifyUser(this.baseUrl, { authorization, cookie })) !== null;
    } catch {
      return false;
    }
  }

  /**
   * True when the caller is a member of the platform Admins group. Used to gate
   * engine-mutating endpoints (device switch, load/unload) — any authed user
   * can read status, but only admins can change the engine's device or VRAM.
   */
  async verifyAdmin(authorization?: string, cookie?: string): Promise<boolean> {
    try {
      const user = await verifyUser(this.baseUrl, { authorization, cookie });
      return user ? user.groupIds.includes(ADMIN_GROUP_ID) : false;
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
   * literal `{populate: "false"}` predicate and returns zero rows. The SDK
   * `list` adds only `_l=500` (no populate param), which is exactly what we want.
   */
  async listVoiceVoices(): Promise<VoiceVoiceRow[]> {
    return this.sdk.list<VoiceVoiceRow>('voice_voices', { _l: '500' });
  }

  /**
   * Patch a voice_voices row. Uses `$set` to avoid the platform validation
   * issues that bare-body patches can hit (see project memory).
   */
  async patchVoiceVoice(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.sdk.update('voice_voices', id, { $set: patch });
  }

  /** Fetch a single voice_notes row by id. */
  async getVoiceNote(id: string): Promise<VoiceNoteRow | null> {
    return this.sdk.get<VoiceNoteRow>('voice_notes', id);
  }

  /** Fetch a single files row by id (metadata only — no bytes). */
  async getFileMeta(id: string): Promise<FileMeta | null> {
    return this.sdk.get<FileMeta>('files', id);
  }

  /**
   * Patch a files row's groupIds via `$set`. Used by `/api/voice-from-note` to
   * widen scope so the voice-backend functional user can read the reference WAV
   * (files RBAC = ownerId match OR groupIds intersection).
   *
   * Pass the user's `authorization`/`cookie` from the original request: the
   * file was uploaded via `uploadDirect` so its row-security has groupIds=[]
   * and only the owner can edit it. The voice-backend's functional user is
   * NOT the owner — but the calling user is, so we proxy the patch under
   * their credentials.
   *
   * SDK gap: `updateAsUser` strips the functional `x-api-key` and supports only
   * a Bearer JWT (no cookie). This forwards BOTH the user's creds AND the
   * functional key, so it stays a raw request authenticated via `getApiKey()`.
   */
  async patchFileGroupIds(
    fileId: string,
    groupIds: string[],
    authorization?: string,
    cookie?: string,
  ): Promise<void> {
    const url = `${this.baseUrl}/api/dynamic/files/${encodeURIComponent(fileId)}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.requestHeaders(authorization, cookie),
      body: JSON.stringify({ $set: { groupIds } }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new CoreApiError('PUT', url, res.status, body.slice(0, 500));
    }
  }

  /**
   * Upload a binary blob to core's `/api/files/uploadDirect`. MUST be called
   * with the originating user's `authorization`/`cookie` so the file is owned
   * by them (matches the dictaphone's own save flow). The voice-backend's
   * functional user is NOT a fallback here — without forwarded auth the file
   * would belong to the functional user and the originating user might lose
   * read access depending on RBAC.
   *
   * SDK gap: the SDK's `uploadFile` uses only the functional key (no end-user
   * forwarding) and a different visibility enum, so this stays a raw multipart
   * request authenticated via `getApiKey()`.
   */
  async uploadFile(
    blob: FileBlob,
    options: { title?: string; visibility?: 'private' | 'public' } = {},
    authorization?: string,
    cookie?: string,
  ): Promise<{ _id: string }> {
    const url = `${this.baseUrl}/api/files/uploadDirect`;
    const form = new FormData();
    form.append(
      'file',
      new Blob([blob.bytes as unknown as BlobPart], { type: blob.mimeType }),
      blob.filename,
    );
    if (options.title) form.append('title', options.title);
    form.append('kind', 'file');
    form.append('visibility', options.visibility ?? 'private');
    // Don't send Content-Type — FormData wants to set its own multipart
    // boundary. Build headers manually with everything BUT Content-Type.
    const apiKey = this.sdk.getApiKey();
    const headers: Record<string, string> = {};
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['x-theitemapp-skip-webhooks'] = '1';
    if (authorization?.trim()) headers.Authorization = authorization.trim();
    if (cookie?.trim()) headers.Cookie = cookie.trim();
    const res = await fetch(url, { method: 'POST', headers, body: form as unknown as BodyInit });
    if (!res.ok) {
      const body = await res.text();
      throw new CoreApiError('POST', url, res.status, body.slice(0, 500));
    }
    return (await res.json()) as { _id: string };
  }

  /**
   * Create a voice_notes row via the dynamic API, attributed to the originating
   * user by forwarding their `authorization`/`cookie`.
   *
   * SDK gap: the SDK has no `createAsUser`, so this stays a raw request
   * authenticated via `getApiKey()` while also forwarding the user's creds.
   */
  async createVoiceNote(
    doc: Record<string, unknown>,
    authorization?: string,
    cookie?: string,
  ): Promise<{ _id: string }> {
    const url = `${this.baseUrl}/api/dynamic/voice_notes`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.requestHeaders(authorization, cookie),
      body: JSON.stringify(doc),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new CoreApiError('POST', url, res.status, body.slice(0, 500));
    }
    return (await res.json()) as { _id: string };
  }

  /** Create a voice_voices row. Returns the inserted document. */
  async createVoiceVoice(doc: Record<string, unknown>): Promise<VoiceVoiceRow> {
    return this.sdk.create<VoiceVoiceRow>('voice_voices', doc);
  }

  /**
   * Stream a `files` record's bytes into memory. Voice reference WAVs are small
   * (a few hundred KB), so buffering the whole blob is fine here.
   *
   * SDK gap: the SDK has no file-download helper, so this stays a raw request
   * (functional key) hitting the metadata + `files/:id/content` endpoints.
   */
  async downloadFile(fileId: string): Promise<FileBlob> {
    const meta = await this.sdk.get<FileMeta>('files', fileId);
    const mimeType = (meta?.mimeType ?? '').trim() || 'application/octet-stream';
    const filename = (meta?.originalName ?? '').trim() || `${fileId}.bin`;

    const contentUrl = `${this.baseUrl}/api/files/${encodeURIComponent(fileId)}/content`;
    const contentRes = await fetch(contentUrl, { method: 'GET', headers: this.functionalHeaders() });
    if (!contentRes.ok) {
      const body = await contentRes.text();
      throw new CoreApiError('GET', contentUrl, contentRes.status, body.slice(0, 500));
    }
    const buf = new Uint8Array(await contentRes.arrayBuffer());
    return { bytes: buf, mimeType, filename };
  }

  /** Functional-key headers (Content-Type + x-api-key + skip-webhooks). */
  private functionalHeaders(): Record<string, string> {
    const apiKey = this.sdk.getApiKey();
    return {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      'x-theitemapp-skip-webhooks': '1',
    };
  }

  /** Functional-key headers plus the originating user's forwarded credentials. */
  private requestHeaders(authorization?: string, cookie?: string): Record<string, string> {
    const header = typeof authorization === 'string' && authorization.trim().length > 0 ? authorization.trim() : '';
    const cookieHeader = typeof cookie === 'string' && cookie.trim().length > 0 ? cookie.trim() : '';
    return {
      ...this.functionalHeaders(),
      ...(header ? { Authorization: header } : {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    };
  }
}
