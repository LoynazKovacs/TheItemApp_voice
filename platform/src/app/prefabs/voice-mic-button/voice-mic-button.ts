import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, EventEmitter, Output, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VoiceApiService } from '../../services/voice-api.service';

/**
 * Push-to-talk mic button. Press & hold to record; release to transcribe.
 * Emits `transcribed` events with the resulting text.
 *
 * Usable as a stand-alone prefab and as a drop-in inside other prefabs (chat
 * composer, coding-agent terminal composer) via the public `transcribed` output.
 */
@Component({
  selector: 'voice-mic-button',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './voice-mic-button.html',
  styleUrl: './voice-mic-button.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceMicButtonComponent implements OnDestroy {
  private readonly api = inject(VoiceApiService);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly windowId = input<string>('');
  readonly language = input<string | null>(null);
  readonly label = input<string>('Push to talk');

  @Output() readonly transcribed = new EventEmitter<string>();
  @Output() readonly errorMessage = new EventEmitter<string>();

  state = signal<'idle' | 'recording' | 'transcribing'>('idle');
  lastError = signal<string | null>(null);
  lastText = signal<string | null>(null);

  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];

  ngOnDestroy(): void {
    this.stopStream();
  }

  async onPressStart(event?: Event) {
    event?.preventDefault();
    if (this.state() !== 'idle') return;
    this.lastError.set(null);
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = this.pickMime();
      this.mediaRecorder = mimeType
        ? new MediaRecorder(this.mediaStream, { mimeType })
        : new MediaRecorder(this.mediaStream);
      this.chunks = [];
      this.mediaRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
      };
      this.mediaRecorder.onstop = () => this.finalizeRecording();
      this.mediaRecorder.start();
      this.state.set('recording');
      this.cdr.markForCheck();
    } catch (err) {
      this.handleError(err);
    }
  }

  onPressEnd(event?: Event) {
    event?.preventDefault();
    if (this.state() !== 'recording') return;
    try {
      this.mediaRecorder?.stop();
    } catch (err) {
      this.handleError(err);
    }
  }

  private async finalizeRecording() {
    const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type: mimeType });
    this.stopStream();
    this.state.set('transcribing');
    this.cdr.markForCheck();

    try {
      const res = await this.api.stt(blob, {
        language: this.language() || undefined,
        task: 'transcribe',
        filename: `recording.${this.extFor(mimeType)}`,
      });
      if (!res.ok) {
        this.lastError.set(res.error || 'Transcription failed');
        this.errorMessage.emit(this.lastError()!);
      } else {
        const text = (res.text || '').trim();
        this.lastText.set(text);
        if (text) this.transcribed.emit(text);
      }
    } catch (err) {
      this.handleError(err);
    } finally {
      this.state.set('idle');
      this.cdr.markForCheck();
    }
  }

  private stopStream() {
    try { this.mediaStream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    this.mediaStream = null;
    this.mediaRecorder = null;
  }

  private handleError(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    this.lastError.set(msg);
    this.errorMessage.emit(msg);
    this.state.set('idle');
    this.stopStream();
    this.cdr.markForCheck();
  }

  private pickMime(): string | undefined {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return undefined;
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
    return undefined;
  }

  private extFor(mime: string): string {
    if (mime.startsWith('audio/webm')) return 'webm';
    if (mime.startsWith('audio/ogg')) return 'ogg';
    if (mime.startsWith('audio/mp4')) return 'm4a';
    if (mime.startsWith('audio/wav')) return 'wav';
    return 'bin';
  }
}
