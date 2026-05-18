import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VoiceApiService } from '../../services/voice-api.service';

/**
 * Speaker button: synthesizes provided `text` on demand and plays it back.
 * Drop into any component / configure via slot inputs.
 */
@Component({
  selector: 'voice-speaker',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './voice-speaker.html',
  styleUrl: './voice-speaker.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceSpeakerComponent implements OnDestroy {
  private readonly api = inject(VoiceApiService);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly windowId = input<string>('');
  readonly text = input<string>('');
  readonly voice = input<string | null>(null);
  readonly format = input<'mp3' | 'wav' | 'opus' | 'flac' | 'aac' | 'pcm'>('mp3');
  readonly speed = input<number>(1.0);
  readonly label = input<string>('Speak');

  state = signal<'idle' | 'loading' | 'playing'>('idle');
  lastError = signal<string | null>(null);

  private currentAudio: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;

  ngOnDestroy(): void {
    this.cleanup();
  }

  async onClick() {
    if (this.state() === 'playing') {
      this.stop();
      return;
    }
    if (this.state() !== 'idle') return;
    const text = (this.text() || '').trim();
    if (!text) {
      this.lastError.set('No text to speak');
      return;
    }
    this.lastError.set(null);
    this.state.set('loading');
    this.cdr.markForCheck();
    try {
      const res = await this.api.tts({
        text,
        voice: this.voice() || undefined,
        format: this.format(),
        speed: this.speed(),
      });
      if (!res.ok) {
        this.lastError.set(res.error);
        this.state.set('idle');
        this.cdr.markForCheck();
        return;
      }
      this.cleanup();
      const url = URL.createObjectURL(res.blob);
      const audio = new Audio(url);
      audio.onended = () => {
        this.cleanup();
        this.state.set('idle');
        this.cdr.markForCheck();
      };
      audio.onerror = () => {
        this.lastError.set('Audio playback failed');
        this.cleanup();
        this.state.set('idle');
        this.cdr.markForCheck();
      };
      this.currentAudio = audio;
      this.currentUrl = url;
      this.state.set('playing');
      this.cdr.markForCheck();
      await audio.play();
    } catch (err) {
      this.lastError.set(err instanceof Error ? err.message : String(err));
      this.cleanup();
      this.state.set('idle');
      this.cdr.markForCheck();
    }
  }

  stop() {
    try { this.currentAudio?.pause(); } catch { /* noop */ }
    this.cleanup();
    this.state.set('idle');
    this.cdr.markForCheck();
  }

  private cleanup() {
    if (this.currentAudio) {
      try { this.currentAudio.pause(); } catch { /* noop */ }
      this.currentAudio = null;
    }
    if (this.currentUrl) {
      try { URL.revokeObjectURL(this.currentUrl); } catch { /* noop */ }
      this.currentUrl = null;
    }
  }
}
