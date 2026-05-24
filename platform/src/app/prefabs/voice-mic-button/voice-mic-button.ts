import { ChangeDetectionStrategy, ChangeDetectorRef, Component, HostListener, OnDestroy, EventEmitter, Output, inject, input, signal } from '@angular/core';
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

  /** Minimum recording duration. MediaRecorder needs time after `start()` to
   *  mux at least one audio cluster — releasing within ~50ms produces a file
   *  containing only the EBML header (~110 bytes) which the STT backend can't
   *  decode. 300ms is enough for the muxer to emit a real cluster on every
   *  browser we support. */
  private static readonly MIN_RECORDING_MS = 300;

  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  /** True when the user released the button while we were still awaiting
   *  `getUserMedia`. Used to abort cleanly without leaving a recorder running. */
  private pendingStop = false;
  /** Wall-clock timestamp of the actual `MediaRecorder.start()` call. */
  private recordStartedAt = 0;
  /** Pending stop timer when the press was shorter than MIN_RECORDING_MS. */
  private stopTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnDestroy(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopStream();
  }

  async onPressStart(event?: Event) {
    event?.preventDefault();
    if (this.state() !== 'idle') return;
    this.lastError.set(null);
    this.pendingStop = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // If the user released the button while we were waiting for the
      // permission/stream, abort here — never start the recorder. Otherwise
      // we'd leak a hot mic and produce no audio anyway.
      if (this.pendingStop) {
        stream.getTracks().forEach((t) => t.stop());
        this.pendingStop = false;
        return;
      }
      this.mediaStream = stream;
      const mimeType = this.pickMime();
      this.mediaRecorder = mimeType
        ? new MediaRecorder(this.mediaStream, { mimeType })
        : new MediaRecorder(this.mediaStream);
      this.chunks = [];
      this.mediaRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
      };
      this.mediaRecorder.onstop = () => this.finalizeRecording();
      // 250 ms timeslice — forces the muxer to flush audio clusters
      // periodically instead of buffering everything until stop(). On a
      // short press the buffered cluster is then guaranteed to be present
      // in the final blob.
      this.mediaRecorder.start(250);
      this.recordStartedAt = performance.now();
      this.state.set('recording');
      this.cdr.markForCheck();
    } catch (err) {
      this.handleError(err);
    }
  }

  // Catch mouseup/touchend anywhere on the document so the recording stops
  // even if the user drifts the pointer off the button before releasing —
  // the previous (mouseleave) handler stopped too eagerly and produced empty
  // recordings.
  @HostListener('document:mouseup', ['$event'])
  @HostListener('document:touchend', ['$event'])
  @HostListener('document:touchcancel', ['$event'])
  onDocumentPressEnd(event?: Event) {
    if (this.state() !== 'recording' && !this.pendingStop) return;
    this.onPressEnd(event);
  }

  onPressEnd(event?: Event) {
    event?.preventDefault();
    // If recording hasn't actually started yet (still awaiting getUserMedia
    // OR already stopping), flag the intent so onPressStart can abort cleanly.
    if (this.state() !== 'recording') {
      this.pendingStop = true;
      return;
    }
    if (this.stopTimer) return; // already scheduled
    const elapsed = performance.now() - this.recordStartedAt;
    const wait = Math.max(0, VoiceMicButtonComponent.MIN_RECORDING_MS - elapsed);
    if (wait > 0) {
      this.stopTimer = setTimeout(() => {
        this.stopTimer = null;
        this.doStop();
      }, wait);
    } else {
      this.doStop();
    }
  }

  private doStop() {
    try {
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        // Force a final cluster flush before stop() so the EBML stream is
        // well-formed even if no timeslice tick fired yet.
        try { this.mediaRecorder.requestData(); } catch { /* noop */ }
        this.mediaRecorder.stop();
      }
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
