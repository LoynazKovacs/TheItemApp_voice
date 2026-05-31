import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { PLATFORM_REALTIME } from '@loynazkovacs/theitemapp-platform-sdk';
import { VoiceApiService } from '../../services/voice-api.service';
import { UserVoicePrefsService } from '../../services/user-voice-prefs.service';

type VoiceRow = Readonly<{
  _id: string;
  key: string;
  displayName: string;
  description?: string;
  profileId: string;
  language?: string;
  gender?: string;
  style?: readonly string[];
  order?: number;
  enabled?: boolean;
}>;

/**
 * User-facing prefab to browse the `voice_voices` catalog, preview a sample,
 * and pick a voice. Persists choice + speed + auto-mode to the user's
 * `user_ui_configs.voice` sub-object.
 *
 * - Voices loaded from `/api/dynamic/voice_voices`, filtered to enabled, sorted by order.
 * - Current selection mirrors `user_ui_configs.voice.selectedVoiceId` (resolved
 *   on init; UI updates optimistically on click).
 * - Preview synthesises a canned sample via `/voice-api/api/tts` with the row's
 *   `profileId` + current speed. Plays inline, one at a time.
 */
@Component({
  selector: 'voice-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './voice-settings.html',
  styleUrl: './voice-settings.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceSettingsComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly api = inject(VoiceApiService);
  private readonly prefs = inject(UserVoicePrefsService);
  private readonly cdr = inject(ChangeDetectorRef);
  /**
   * Host-provided realtime, forwarded into the shared prefs service so its
   * cached `profileId` stays in sync with backend edits to `user_ui_configs`.
   * See VoicePrefsRealtime / UserVoicePrefsService.bindRealtime.
   */
  private readonly platformRealtime = inject(PLATFORM_REALTIME, { optional: true });

  constructor() {
    // Idempotent — first prefab to mount sets up the subscription, later
    // mounts are no-ops. Settings is included alongside speaker so the
    // wiring works even when only settings is open at app startup.
    this.prefs.bindRealtime(this.platformRealtime ?? null);
  }

  readonly windowId = input<string>('');

  voices = signal<readonly VoiceRow[]>([]);
  loading = signal<boolean>(true);
  loadError = signal<string | null>(null);

  /** Selected `voice_voices._id` — drives the UI tick. */
  selectedId = signal<string | null>(null);
  speed = signal<number>(1.0);
  autoMode = signal<boolean>(false);

  /** _id of the user's user_ui_configs doc — needed to PATCH preferences. */
  private configDocId: string | null = null;

  /** Currently-previewing voice _id (button spinner state). */
  previewingId = signal<string | null>(null);
  /** Last preview error, displayed under the row that triggered it. */
  previewError = signal<{ id: string; msg: string } | null>(null);

  /** Map id → row for the selected-voice summary card. */
  readonly selectedRow = computed<VoiceRow | null>(() => {
    const id = this.selectedId();
    if (!id) return null;
    return this.voices().find(v => v._id === id) ?? null;
  });

  private currentAudio: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;
  private previewJob = 0;

  ngOnInit(): void {
    void this.loadAll();
  }

  private async loadAll(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      // Fetch in parallel — voices are public-ish, user config is per-user.
      const [voicesRes, configRes] = await Promise.all([
        firstValueFrom(this.http.get<unknown>('/api/dynamic/voice_voices', {
          // Core dynamic-list sort param is `_s` (not `_sort`). An unrecognised
          // `_sort` survives as an exact-match filter `{_sort:'order'}`, which
          // matches no document and silently empties the picker.
          params: { _l: 200, _s: 'order', _f: JSON.stringify({ enabled: true }) },
        })),
        firstValueFrom(this.http.get<unknown>('/api/dynamic/user_ui_configs', { params: { _l: 1 } })),
      ]);

      const rows: VoiceRow[] = Array.isArray(voicesRes)
        ? (voicesRes as VoiceRow[]).map(normalizeRow).filter(v => !!v._id && !!v.profileId)
        : [];
      // Belt-and-braces sort in case backend ignored `_sort`.
      rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      this.voices.set(rows);

      const configDoc = Array.isArray(configRes) ? (configRes[0] as Record<string, unknown> | undefined) : undefined;
      this.configDocId = typeof configDoc?.['_id'] === 'string' ? (configDoc['_id'] as string) : null;
      const voicePref = (configDoc?.['voice'] as
        | { selectedVoiceId?: unknown; speed?: number; autoMode?: boolean }
        | undefined) ?? undefined;
      const rawSel = voicePref?.selectedVoiceId;
      // user_ui_configs.voice.selectedVoiceId is an x-ref to voice_voices —
      // dynamic API populates x-refs as objects with `_id` (and other fields).
      // Normalise both shapes here.
      const selId = typeof rawSel === 'string'
        ? rawSel
        : (rawSel && typeof rawSel === 'object' && typeof (rawSel as { _id?: unknown })._id === 'string')
          ? ((rawSel as { _id: string })._id)
          : null;
      this.selectedId.set(selId);
      if (typeof voicePref?.speed === 'number') this.speed.set(voicePref.speed);
      if (typeof voicePref?.autoMode === 'boolean') this.autoMode.set(voicePref.autoMode);
    } catch (err) {
      this.loadError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
      this.cdr.markForCheck();
    }
  }

  async selectVoice(row: VoiceRow): Promise<void> {
    const previous = this.selectedId();
    this.selectedId.set(row._id);
    this.cdr.markForCheck();
    const ok = await this.patchConfig({ 'voice.selectedVoiceId': row._id });
    if (!ok) {
      this.selectedId.set(previous);
      this.cdr.markForCheck();
    }
  }

  async setSpeed(v: number | string): Promise<void> {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (!Number.isFinite(n)) return;
    const clamped = Math.min(2.0, Math.max(0.5, Math.round(n * 100) / 100));
    const previous = this.speed();
    this.speed.set(clamped);
    this.cdr.markForCheck();
    const ok = await this.patchConfig({ 'voice.speed': clamped });
    if (!ok) {
      this.speed.set(previous);
      this.cdr.markForCheck();
    }
  }

  async toggleAutoMode(v: boolean): Promise<void> {
    const previous = this.autoMode();
    this.autoMode.set(v);
    this.cdr.markForCheck();
    const ok = await this.patchConfig({ 'voice.autoMode': v });
    if (!ok) {
      this.autoMode.set(previous);
      this.cdr.markForCheck();
    }
  }

  /**
   * Synthesises a short canned sample with the row's profileId at the current
   * speed and plays it inline. Cancels any currently-playing preview.
   */
  async preview(row: VoiceRow): Promise<void> {
    // Toggle off if user clicks the row that's already previewing.
    if (this.previewingId() === row._id) {
      this.stopPreview();
      return;
    }
    this.stopPreview();
    const myJob = ++this.previewJob;
    this.previewingId.set(row._id);
    this.previewError.set(null);
    this.cdr.markForCheck();

    const sample = `Hello, this is the ${row.displayName} voice.`;
    const res = await this.api.tts({
      text: sample,
      voice: row.profileId,
      format: 'mp3',
      speed: this.speed(),
    });
    if (this.previewJob !== myJob) return;
    if (!res.ok) {
      this.previewError.set({ id: row._id, msg: res.error });
      this.previewingId.set(null);
      this.cdr.markForCheck();
      return;
    }
    const url = URL.createObjectURL(res.blob);
    const audio = new Audio(url);
    this.currentAudio = audio;
    this.currentUrl = url;
    audio.onended = () => {
      if (this.previewJob !== myJob) return;
      this.cleanupAudio();
      this.previewingId.set(null);
      this.cdr.markForCheck();
    };
    audio.onerror = () => {
      if (this.previewJob !== myJob) return;
      this.previewError.set({ id: row._id, msg: 'Audio playback failed' });
      this.cleanupAudio();
      this.previewingId.set(null);
      this.cdr.markForCheck();
    };
    audio.play().catch(err => {
      if (this.previewJob !== myJob) return;
      this.previewError.set({ id: row._id, msg: err instanceof Error ? err.message : String(err) });
      this.cleanupAudio();
      this.previewingId.set(null);
      this.cdr.markForCheck();
    });
  }

  stopPreview(): void {
    this.previewJob++;
    this.cleanupAudio();
    this.previewingId.set(null);
    this.cdr.markForCheck();
  }

  private cleanupAudio(): void {
    if (this.currentAudio) {
      try { this.currentAudio.pause(); } catch { /* noop */ }
      this.currentAudio = null;
    }
    if (this.currentUrl) {
      try { URL.revokeObjectURL(this.currentUrl); } catch { /* noop */ }
      this.currentUrl = null;
    }
  }

  /**
   * PATCH the user's user_ui_configs doc with $set dot-paths under
   * `voice.*`. Returns true on success so callers can revert optimistic
   * updates on failure.
   *
   * After a successful write we refresh the singleton UserVoicePrefsService
   * so the in-page VoiceSpeakerPrefab instances pick up the new voice without
   * a page reload.
   */
  private async patchConfig(patch: Record<string, unknown>): Promise<boolean> {
    if (!this.configDocId) {
      this.loadError.set('Voice settings could not load your user config — try refreshing.');
      this.cdr.markForCheck();
      return false;
    }
    try {
      await firstValueFrom(
        this.http.put(`/api/dynamic/user_ui_configs/${this.configDocId}`, { $set: patch }),
      );
      // Best-effort refresh of the singleton so other prefab instances pick
      // up the new pref. Don't block the UI on it.
      void this.prefs.refresh();
      return true;
    } catch (err) {
      this.loadError.set(err instanceof Error ? err.message : String(err));
      this.cdr.markForCheck();
      return false;
    }
  }
}

/**
 * Normalise an x-ref row coming from `/api/dynamic/voice_voices` — `_id`
 * may be a string or an object with `$oid`.
 */
function normalizeRow(r: VoiceRow): VoiceRow {
  const rawId = (r as unknown as { _id: unknown })._id;
  const id = typeof rawId === 'string'
    ? rawId
    : (rawId && typeof rawId === 'object' && typeof (rawId as { $oid?: unknown }).$oid === 'string')
      ? (rawId as { $oid: string }).$oid
      : '';
  return { ...r, _id: id } as VoiceRow;
}
