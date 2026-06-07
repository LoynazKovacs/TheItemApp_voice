import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit, computed, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VoiceApiService, type EngineStatus } from '../../services/voice-api.service';

/**
 * Voice Engine control panel (standalone prefab).
 *
 * Monitors and controls the OmniVoice engine's compute device:
 *  - Live status: effective device (GPU/CPU), TTS load state, VRAM used/total.
 *  - Switch device GPU<->CPU in-process (no container restart) via
 *    /voice-api/api/engine/device — the backend flips the engine's single
 *    device lever (torch.cuda.is_available) so TTS + ASR follow consistently.
 *  - Load / Unload the models on demand to free or warm VRAM.
 *
 * Status reads are open to any authed user; mutations require admin (the
 * backend returns 403 otherwise, surfaced inline). Polls status every 3s while
 * mounted so the panel mirrors changes made elsewhere (e.g. the System app).
 */
@Component({
  selector: 'voice-engine',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './voice-engine.html',
  styleUrl: './voice-engine.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceEngineComponent implements OnInit, OnDestroy {
  private readonly api = inject(VoiceApiService);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly windowId = input<string>('');

  status = signal<EngineStatus | null>(null);
  loadingStatus = signal<boolean>(true);
  busy = signal<string | null>(null); // which action is in flight
  actionError = signal<string | null>(null);
  actionNote = signal<string | null>(null);

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  readonly device = computed(() => this.status()?.device ?? '—');
  readonly isGpu = computed(() => (this.status()?.device ?? '').startsWith('cuda'));
  readonly cudaAvailable = computed(() => this.status()?.cuda_available === true);
  readonly ttsLoaded = computed(() => this.status()?.tts_loaded === true);
  readonly ttsLoading = computed(() => this.status()?.tts_loading === true);
  readonly asrLoaded = computed(() => this.status()?.asr_loaded === true);

  readonly vramPct = computed(() => {
    const s = this.status();
    const used = s?.vram_used_mb;
    const total = s?.vram_total_mb;
    if (typeof used !== 'number' || typeof total !== 'number' || total <= 0) return null;
    return Math.min(100, Math.round((used / total) * 100));
  });

  ngOnInit(): void {
    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(true), 3000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  async refresh(silent = false): Promise<void> {
    if (!silent) this.loadingStatus.set(true);
    const res = await this.api.engineStatus();
    this.status.set(res);
    this.loadingStatus.set(false);
    this.cdr.markForCheck();
  }

  async switchDevice(target: 'cpu' | 'cuda'): Promise<void> {
    if (this.busy()) return;
    if (target === 'cuda' && !this.cudaAvailable()) {
      this.actionError.set('GPU is not available to this container — restart the voice stack with the GPU visible.');
      this.cdr.markForCheck();
      return;
    }
    this.busy.set(`device:${target}`);
    this.actionError.set(null);
    this.actionNote.set(null);
    this.cdr.markForCheck();
    const res = await this.api.setEngineDevice(target);
    if (res.ok) {
      this.status.set(res);
      this.actionNote.set(`Engine switched to ${target === 'cuda' ? 'GPU' : 'CPU'}.`);
    } else {
      this.actionError.set(res.error || 'Device switch failed.');
    }
    this.busy.set(null);
    this.cdr.markForCheck();
  }

  async load(): Promise<void> {
    if (this.busy()) return;
    this.busy.set('load');
    this.actionError.set(null);
    this.actionNote.set(null);
    this.cdr.markForCheck();
    const res = await this.api.engineLoad();
    if (res.ok) {
      this.status.set(res);
      this.actionNote.set('Model loaded.');
    } else {
      this.actionError.set(res.error || 'Load failed.');
    }
    this.busy.set(null);
    this.cdr.markForCheck();
  }

  async unload(): Promise<void> {
    if (this.busy()) return;
    this.busy.set('unload');
    this.actionError.set(null);
    this.actionNote.set(null);
    this.cdr.markForCheck();
    const res = await this.api.engineUnload();
    if (res.ok) {
      this.status.set(res);
      this.actionNote.set('Models unloaded — VRAM freed. They reload on next use.');
    } else {
      this.actionError.set(res.error || 'Unload failed.');
    }
    this.busy.set(null);
    this.cdr.markForCheck();
  }
}
