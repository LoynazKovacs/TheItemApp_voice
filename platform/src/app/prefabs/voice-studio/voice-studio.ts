import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { VoiceApiService, type VoiceInfo } from '../../services/voice-api.service';
import { VoiceMicButtonComponent } from '../voice-mic-button/voice-mic-button';
import { VoiceSpeakerComponent } from '../voice-speaker/voice-speaker';

type UpstreamHealth = {
  ok: boolean;
  upstreams?: { tts?: { ok: boolean; error?: string }; stt?: { ok: boolean; error?: string } };
  error?: string;
};

@Component({
  selector: 'voice-studio',
  standalone: true,
  imports: [CommonModule, FormsModule, VoiceMicButtonComponent, VoiceSpeakerComponent],
  templateUrl: './voice-studio.html',
  styleUrl: './voice-studio.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceStudioComponent implements OnInit {
  private readonly api = inject(VoiceApiService);
  private readonly http = inject(HttpClient);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly windowId = input<string>('');

  text = signal<string>('Hello! This is a quick test of the voice studio.');
  selectedVoice = signal<string | null>(null);
  speed = signal<number>(1.0);
  voices = signal<readonly VoiceInfo[]>([]);
  voicesLoading = signal<boolean>(false);
  voicesError = signal<string | null>(null);

  transcripts = signal<readonly { at: number; text: string }[]>([]);
  health = signal<UpstreamHealth | null>(null);
  healthLoading = signal<boolean>(false);

  ngOnInit(): void {
    void this.refreshHealth();
    void this.loadVoices();
  }

  async refreshHealth() {
    this.healthLoading.set(true);
    try {
      const h = await this.api.health();
      this.health.set(h as UpstreamHealth);
    } finally {
      this.healthLoading.set(false);
      this.cdr.markForCheck();
    }
  }

  async loadVoices() {
    this.voicesLoading.set(true);
    this.voicesError.set(null);
    try {
      // Load the curated `voice_voices` catalog (same source as the Settings
      // picker) rather than raw OmniVoice engine profiles, so every catalog
      // voice — OmniVoice clones AND local open-source Piper voices — is
      // selectable here. The row's `profileId` (e.g. `piper:<model>`) is what
      // the speaker forwards to `/api/tts`, where the engine is routed.
      // NB: the core dynamic-list sort param is `_s` (not `_sort`).
      const rows = await firstValueFrom(
        this.http.get<unknown>('/api/dynamic/voice_voices', {
          params: { _l: 200, _s: 'order', _f: JSON.stringify({ enabled: true }) },
        }),
      );
      const voices: VoiceInfo[] = (Array.isArray(rows) ? rows : [])
        .map((r) => {
          const row = r as { profileId?: unknown; displayName?: unknown; language?: unknown; gender?: unknown };
          const id = typeof row.profileId === 'string' ? row.profileId : '';
          return {
            id,
            name: typeof row.displayName === 'string' ? row.displayName : id,
            language: typeof row.language === 'string' ? row.language : undefined,
            gender: typeof row.gender === 'string' ? row.gender : undefined,
          } as VoiceInfo;
        })
        .filter((v) => !!v.id);
      this.voices.set(voices);
      if (!this.selectedVoice() && voices.length > 0) {
        this.selectedVoice.set(voices[0].id);
      }
    } catch (err) {
      this.voicesError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.voicesLoading.set(false);
      this.cdr.markForCheck();
    }
  }

  setVoice(id: string) {
    this.selectedVoice.set(id);
  }

  setText(t: string) {
    this.text.set(t);
  }

  setSpeed(v: number | string) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) this.speed.set(n);
  }

  onTranscribed(t: string) {
    if (!t) return;
    this.transcripts.update((prev) => [{ at: Date.now(), text: t }, ...prev].slice(0, 50));
    // Convenience: also stuff into the text input so you can immediately speak it back.
    this.text.update((current) => (current?.trim() ? `${current}\n${t}` : t));
  }

  copyToInput(t: string) {
    this.text.set(t);
  }

  clearTranscripts() {
    this.transcripts.set([]);
  }

  voiceLabel(v: VoiceInfo): string {
    return v.name || v.id;
  }

  ttsStatus(): { state: 'ok' | 'down' | 'unknown'; detail?: string } {
    const h = this.health();
    if (!h) return { state: 'unknown' };
    const u = h.upstreams?.tts;
    if (!u) return { state: 'unknown' };
    return u.ok ? { state: 'ok' } : { state: 'down', detail: u.error };
  }

  sttStatus(): { state: 'ok' | 'down' | 'unknown'; detail?: string } {
    const h = this.health();
    if (!h) return { state: 'unknown' };
    const u = h.upstreams?.stt;
    if (!u) return { state: 'unknown' };
    return u.ok ? { state: 'ok' } : { state: 'down', detail: u.error };
  }
}
