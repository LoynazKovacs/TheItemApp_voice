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
 * User-attributed writes/uploads (`createVoiceNote`, `uploadFile`,
 * `patchFileGroupIds`) forward the END USER's `Authorization`/`Cookie` (so the
 * file/note is owned by / editable by the caller, per files RBAC) WHILE still
 * carrying the functional `x-api-key` + skip-webhooks header. This is exactly
 * the SDK's `asUser({ authorization, cookie }, { keepApiKey: true })` scoped
 * client — no raw `fetch` needed. `downloadFile` delegates to the SDK's
 * `downloadFile(id)` (functional key) and maps `{ data, contentType, filename }`
 * to this app's `FileBlob` shape.
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
   * their credentials via `asUser(..., { keepApiKey: true })` (forwards the
   * user's creds AND the functional key + skip-webhooks header).
   */
  async patchFileGroupIds(
    fileId: string,
    groupIds: string[],
    authorization?: string,
    cookie?: string,
  ): Promise<void> {
    await this.sdk
      .asUser({ authorization, cookie }, { keepApiKey: true })
      .update('files', fileId, { $set: { groupIds } });
  }

  /**
   * Upload a binary blob to core's `/api/files/uploadDirect`. MUST be called
   * with the originating user's `authorization`/`cookie` so the file is owned
   * by them (matches the dictaphone's own save flow). The voice-backend's
   * functional user is NOT a fallback here — without forwarded auth the file
   * would belong to the functional user and the originating user might lose
   * read access depending on RBAC.
   *
   * Delegates to `asUser(..., { keepApiKey: true }).uploadFile(...)` — the
   * scoped client forwards the user's creds AND the functional key + skip-
   * webhooks header, and builds the multipart body. `kind: 'file'` and the
   * `private`-default visibility match the prior raw form fields.
   */
  async uploadFile(
    blob: FileBlob,
    options: { title?: string; visibility?: 'private' | 'public' } = {},
    authorization?: string,
    cookie?: string,
  ): Promise<{ _id: string }> {
    return this.sdk
      .asUser({ authorization, cookie }, { keepApiKey: true })
      .uploadFile(blob.bytes, {
        filename: blob.filename,
        mimeType: blob.mimeType,
        kind: 'file',
        visibility: options.visibility === 'public' ? 'everyone' : 'private',
        ...(options.title ? { title: options.title } : {}),
      });
  }

  /**
   * Create a voice_notes row via the dynamic API, attributed to the originating
   * user by forwarding their `authorization`/`cookie` via
   * `asUser(..., { keepApiKey: true })` (user creds + functional key).
   */
  async createVoiceNote(
    doc: Record<string, unknown>,
    authorization?: string,
    cookie?: string,
  ): Promise<{ _id: string }> {
    return this.sdk
      .asUser({ authorization, cookie }, { keepApiKey: true })
      .create<{ _id: string }>('voice_notes', doc);
  }

  /** Create a voice_voices row. Returns the inserted document. */
  async createVoiceVoice(doc: Record<string, unknown>): Promise<VoiceVoiceRow> {
    return this.sdk.create<VoiceVoiceRow>('voice_voices', doc);
  }

  /**
   * Stream a `files` record's bytes into memory. Voice reference WAVs are small
   * (a few hundred KB), so buffering the whole blob is fine here.
   *
   * Delegates to the SDK's `downloadFile(id)` (functional key) and maps its
   * `{ data, contentType, filename }` to this app's `FileBlob`. The SDK returns
   * `null` on a genuine 404 — preserve the prior throwing behaviour (callers
   * expect a `FileBlob`, never null) by raising a `CoreApiError`.
   */
  async downloadFile(fileId: string): Promise<FileBlob> {
    const file = await this.sdk.downloadFile(fileId);
    if (!file) {
      throw new CoreApiError('GET', `${this.baseUrl}/api/files/${encodeURIComponent(fileId)}/content`, 404, 'File content not found');
    }
    const mimeType = (file.contentType ?? '').trim() || 'application/octet-stream';
    const filename = (file.filename ?? '').trim() || `${fileId}.bin`;
    return { bytes: file.data, mimeType, filename };
  }
}
