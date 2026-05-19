import type { FastifyBaseLogger } from 'fastify';
import type { CoreApiClient, VoiceVoiceRow } from './coreApiClient.js';
import type { OmniVoiceClient } from './omnivoiceClient.js';

export interface VoiceProfileReconcilerOptions {
  coreApi: CoreApiClient;
  omnivoice: OmniVoiceClient;
  logger: FastifyBaseLogger;
  /** Poll interval for the periodic sweep. */
  intervalMs?: number;
}

/**
 * Background service that keeps OmniVoice voice profiles in sync with the
 * `voice_voices` catalog stored in core.
 *
 * For every `voice_voices` row that has `audioFileId` + `refText`:
 *   - if `profileId` is empty or doesn't exist on OmniVoice, download the
 *     reference WAV from core's `files` collection and POST it to OmniVoice
 *     `/profiles`, then PATCH `voice_voices.profileId` with the returned id.
 *
 * This makes the catalog self-healing: a fresh OmniVoice volume gets all
 * profiles re-provisioned on the next sweep, because the source-of-truth
 * (the WAVs) lives in core, not in OmniVoice.
 *
 * The sweep is idempotent and runs:
 *   - once on startup (after voice-api has a coreApiKey),
 *   - then on a fixed interval (default 30s),
 *   - and on demand via `requestSweep()` (e.g. trigger after writing back).
 */
export class VoiceProfileReconciler {
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pendingSweep = false;
  private stopped = false;

  constructor(private readonly opts: VoiceProfileReconcilerOptions) {
    this.intervalMs = Math.max(5_000, opts.intervalMs ?? 30_000);
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.runSweep();
    this.timer = setInterval(() => {
      void this.runSweep();
    }, this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Schedule a sweep ASAP; coalesces concurrent triggers. */
  requestSweep(): void {
    if (this.running) {
      this.pendingSweep = true;
      return;
    }
    void this.runSweep();
  }

  private async runSweep(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.pendingSweep = true;
      return;
    }
    this.running = true;
    try {
      if (!this.opts.coreApi.hasApiKey()) {
        this.opts.logger.debug('[voiceReconciler] skipped — no core API key yet');
        return;
      }
      await this.sweepOnce();
    } catch (err) {
      this.opts.logger.warn({ err }, '[voiceReconciler] sweep failed');
    } finally {
      this.running = false;
      if (this.pendingSweep && !this.stopped) {
        this.pendingSweep = false;
        void this.runSweep();
      }
    }
  }

  private async sweepOnce(): Promise<void> {
    const rows = await this.opts.coreApi.listVoiceVoices();
    if (rows.length === 0) return;

    let provisioned = 0;
    let skipped = 0;
    let errors = 0;

    for (const row of rows) {
      try {
        const reconciled = await this.reconcileRow(row);
        if (reconciled === 'provisioned') provisioned += 1;
        else skipped += 1;
      } catch (err) {
        errors += 1;
        this.opts.logger.warn(
          { err: err instanceof Error ? { message: err.message, stack: err.stack } : err, voiceVoiceId: row._id, key: row.key },
          '[voiceReconciler] row reconcile failed',
        );
      }
    }

    if (provisioned > 0 || errors > 0) {
      this.opts.logger.info(
        { provisioned, skipped, errors, total: rows.length },
        '[voiceReconciler] sweep complete',
      );
    } else {
      this.opts.logger.debug(
        { skipped, total: rows.length },
        '[voiceReconciler] sweep complete (nothing to do)',
      );
    }
  }

  private async reconcileRow(row: VoiceVoiceRow): Promise<'provisioned' | 'skipped'> {
    const audioFileId = extractFileId(row.audioFileId);
    const refText = typeof row.refText === 'string' ? row.refText.trim() : '';
    const currentProfileId = typeof row.profileId === 'string' ? row.profileId.trim() : '';
    const provisionedFromAudio = typeof row.provisionedFromAudioFileId === 'string'
      ? row.provisionedFromAudioFileId.trim()
      : '';
    const provisionedFromText = typeof row.provisionedFromRefText === 'string'
      ? row.provisionedFromRefText
      : '';

    // Nothing to do if the row doesn't declare an audio source — e.g. legacy
    // demo0001 still provisioned out-of-band by the omnivoice-config sidecar.
    if (!audioFileId) return 'skipped';
    if (!refText) {
      this.opts.logger.warn(
        { voiceVoiceId: row._id, key: row.key },
        '[voiceReconciler] row has audioFileId but no refText — needs a transcript',
      );
      return 'skipped';
    }

    // Decide whether we need to (re)provision:
    //   1. no profileId yet               → provision
    //   2. profileId is missing on OmniVoice (volume reset, etc.) → re-provision
    //   3. audioFileId or refText drifted from what produced the current
    //      profileId → delete old profile, re-provision
    let reason: 'missing' | 'stale-upstream' | 'drift-audio' | 'drift-text' | null = null;
    if (!currentProfileId) {
      reason = 'missing';
    } else {
      try {
        const exists = await this.opts.omnivoice.hasProfile(currentProfileId);
        if (!exists) reason = 'stale-upstream';
      } catch (err) {
        // Transient OmniVoice error — leave the row alone, try next sweep.
        this.opts.logger.debug(
          { err, voiceVoiceId: row._id },
          '[voiceReconciler] hasProfile check failed (will retry next sweep)',
        );
        return 'skipped';
      }
      if (!reason) {
        if (provisionedFromAudio !== audioFileId) reason = 'drift-audio';
        else if (provisionedFromText !== refText) reason = 'drift-text';
      }
    }

    if (!reason) return 'skipped';

    if (reason !== 'missing') {
      this.opts.logger.info(
        {
          voiceVoiceId: row._id,
          key: row.key,
          staleProfileId: currentProfileId,
          reason,
          audioFileId,
          provisionedFromAudio: provisionedFromAudio || null,
        },
        '[voiceReconciler] re-provisioning voice profile',
      );
    }

    // Download reference audio from core.
    const blob = await this.opts.coreApi.downloadFile(audioFileId);

    // Create the new profile in OmniVoice BEFORE deleting the old one, so a
    // failure here doesn't leave the row with no usable profile.
    const profileName = (typeof row.displayName === 'string' && row.displayName.trim())
      || (typeof row.key === 'string' && row.key.trim())
      || `voice-${row._id.slice(-6)}`;
    const language = typeof row.language === 'string' && row.language.trim() ? row.language.trim() : 'Auto';

    const created = await this.opts.omnivoice.createProfile({
      name: profileName,
      refAudio: blob.bytes,
      refText,
      filename: blob.filename,
      mimeType: blob.mimeType,
      language,
    });

    // Write back the new profileId + drift markers atomically.
    await this.opts.coreApi.patchVoiceVoice(row._id, {
      profileId: created.id,
      provisionedFromAudioFileId: audioFileId,
      provisionedFromRefText: refText,
    });

    // Clean up the old OmniVoice profile if it was a real drift event (not
    // just missing/stale). Best-effort — failure here is logged but doesn't
    // fail the sweep, since the row is already pointing at the new profile.
    if ((reason === 'drift-audio' || reason === 'drift-text') && currentProfileId && currentProfileId !== created.id) {
      try {
        await this.opts.omnivoice.deleteProfile(currentProfileId);
        this.opts.logger.info(
          { voiceVoiceId: row._id, deletedProfileId: currentProfileId },
          '[voiceReconciler] deleted stale OmniVoice profile',
        );
      } catch (err) {
        this.opts.logger.warn(
          { err, voiceVoiceId: row._id, staleProfileId: currentProfileId },
          '[voiceReconciler] failed to delete stale OmniVoice profile (orphan left behind)',
        );
      }
    }

    this.opts.logger.info(
      { voiceVoiceId: row._id, key: row.key, profileId: created.id, audioFileId, reason },
      '[voiceReconciler] provisioned voice profile',
    );
    return 'provisioned';
  }
}

/**
 * `audioFileId` can come back from the dynamic API as either a plain string
 * (when fetched with populate=false) or as a populated object with `_id`. We
 * pass populate=false in the reconciler, but tolerate both shapes defensively.
 */
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
