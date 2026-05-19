import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/**
 * Per-user voice preferences resolved from `user_ui_configs.voice`.
 *
 * The user's `user_ui_configs` doc stores `voice.selectedVoiceId` as an
 * x-ref to a `voice_voices` row. The VoiceSpeakerPrefab needs the OmniVoice
 * `profileId` (not the row id) to send to `/voice-api/api/tts`, so this
 * service resolves the x-ref hop on first load and caches both ids.
 *
 * Singleton at root: every voice-speaker / voice-studio / settings UI on
 * the page shares the same fetched state. First consumer kicks off the
 * load; subsequent consumers read the resolved signals.
 */
@Injectable({ providedIn: 'root' })
export class UserVoicePrefsService {
  private readonly http = inject(HttpClient);

  /** Resolved OmniVoice profile id, or null when no pref / still loading. */
  readonly profileId = signal<string | null>(null);
  /** Raw voice_voices._id reference from user_ui_configs. */
  readonly selectedVoiceId = signal<string | null>(null);
  readonly speed = signal<number>(1.0);
  readonly autoMode = signal<boolean>(false);

  readonly loaded = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  /** Memoised hot-load promise so concurrent consumers share one fetch. */
  private loadPromise: Promise<void> | null = null;

  /** Trigger initial load. Safe to call multiple times — idempotent. */
  ensureLoaded(): Promise<void> {
    if (this.loaded()) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.load().finally(() => {
      this.loaded.set(true);
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  /** Force a re-fetch (e.g. after the settings prefab updates the pref). */
  async refresh(): Promise<void> {
    this.loaded.set(false);
    this.loadPromise = null;
    await this.ensureLoaded();
  }

  private async load(): Promise<void> {
    try {
      const rows = await firstValueFrom(
        this.http.get<unknown>('/api/dynamic/user_ui_configs', { params: { _l: 1 } }),
      );
      const doc = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
      const voice = (doc?.['voice'] as
        | { selectedVoiceId?: unknown; speed?: number; autoMode?: boolean }
        | undefined) ?? undefined;
      if (typeof voice?.speed === 'number') this.speed.set(voice.speed);
      if (typeof voice?.autoMode === 'boolean') this.autoMode.set(voice.autoMode);

      // selectedVoiceId is an x-ref to voice_voices. The dynamic API populates
      // x-refs by default, so it usually comes back as an object `{_id, ...}`
      // (with whatever display fields the items doc declares). Accept both
      // shapes; if the populated object already carries `profileId`, skip the
      // second hop.
      const raw = voice?.selectedVoiceId;
      let vid: string | null = null;
      let inlineProfileId: string | null = null;
      if (typeof raw === 'string') {
        vid = raw;
      } else if (raw && typeof raw === 'object') {
        const obj = raw as { _id?: unknown; profileId?: unknown };
        if (typeof obj._id === 'string') vid = obj._id;
        if (typeof obj.profileId === 'string' && obj.profileId) inlineProfileId = obj.profileId;
      }
      this.selectedVoiceId.set(vid);

      if (inlineProfileId) {
        this.profileId.set(inlineProfileId);
      } else if (vid && /^[0-9a-f]{24}$/i.test(vid)) {
        const voiceRow = await firstValueFrom(
          this.http.get<unknown>(`/api/dynamic/voice_voices/${vid}`),
        );
        const profile = (voiceRow as { profileId?: string } | undefined)?.profileId;
        if (typeof profile === 'string' && profile) this.profileId.set(profile);
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }
}
