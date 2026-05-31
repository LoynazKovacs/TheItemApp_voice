import { ChangeDetectionStrategy, ChangeDetectorRef, Component, HostListener, OnDestroy, EventEmitter, Output, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VoiceApiService } from '../../services/voice-api.service';

/**
 * Mic button with two input modes:
 *
 *  1. **Push-to-talk** (default) — press & hold the main button to record,
 *     release to transcribe. Emits `transcribed` with the text. This path is
 *     latency-critical and untouched: `mousedown` starts recording immediately.
 *
 *  2. **Hands-free** — toggled by the separate "live" control next to the mic
 *     (never via the main button, so PTT pays no timing penalty). When armed
 *     the button turns green (same look as the auto-speak speaker) and a single
 *     mic stream stays open. A Web-Audio RMS voice-activity detector segments
 *     speech automatically: each utterance is captured, and after
 *     `silenceMs` of silence it is transcribed and emitted via `autoSend` —
 *     then the detector immediately listens for the next utterance. `autoSend`
 *     is distinct from `transcribed` so hosts can choose to auto-submit
 *     hands-free input while still merely filling the box for PTT.
 *
 * Usable as a stand-alone prefab and as a drop-in inside other prefabs (chat
 * composer, coding-agent terminal composer) via the `transcribed`/`autoSend`
 * outputs.
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

  /** Hands-free: milliseconds of trailing silence that ends an utterance. */
  readonly silenceMs = input<number>(2000);
  /**
   * Hands-free: absolute RMS floor (0..1). A frame is never treated as speech
   * below this, regardless of the adaptive noise floor — guards against the
   * detector latching onto pure silence. The real speech decision is RELATIVE
   * to a continuously-calibrated ambient noise floor (see `vadTick`), so this
   * does NOT need per-mic tuning; it's just a sanity floor.
   */
  readonly vadThreshold = input<number>(0.008);

  @Output() readonly transcribed = new EventEmitter<string>();
  /** Hands-free auto-segmented utterance — hosts may auto-submit this. */
  @Output() readonly autoSend = new EventEmitter<string>();
  @Output() readonly errorMessage = new EventEmitter<string>();

  state = signal<'idle' | 'recording' | 'transcribing'>('idle');
  lastError = signal<string | null>(null);
  lastText = signal<string | null>(null);

  /** True while hands-free listening mode is armed (the green state). */
  handsFree = signal<boolean>(false);
  /** True while a hands-free segment is actively capturing detected speech. */
  listening = signal<boolean>(false);

  /** Minimum recording duration. MediaRecorder needs time after `start()` to
   *  mux at least one audio cluster — releasing within ~50ms produces a file
   *  containing only the EBML header (~110 bytes) which the STT backend can't
   *  decode. 300ms is enough for the muxer to emit a real cluster on every
   *  browser we support. */
  private static readonly MIN_RECORDING_MS = 300;

  /* ---- Push-to-talk state ---- */
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

  /* ---- Hands-free (VAD) state ---- */
  private static readonly VAD_POLL_MS = 50;
  /** Voiced audio shorter than this is treated as noise and discarded. */
  private static readonly MIN_SPEECH_MS = 300;
  /** A frame counts as speech when its RMS exceeds the ambient noise floor by
   *  this factor (relative detection — self-calibrating, mic-independent). */
  private static readonly SPEECH_RATIO = 2.2;
  /** Hard cap on a single utterance; force-flush past this so a noisy mic that
   *  never dips to "silence" still produces output instead of hanging open. */
  private static readonly MAX_SEGMENT_MS = 20000;
  /** EMA smoothing for the ambient noise floor (updated on non-speech frames). */
  private static readonly NOISE_EMA = 0.05;
  private hfStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private vadData: Float32Array<ArrayBuffer> | null = null;
  private vadTimer: ReturnType<typeof setInterval> | null = null;
  private hfRecorder: MediaRecorder | null = null;
  private hfChunks: BlobPart[] = [];
  private segmentActive = false;
  private voicedMs = 0;
  private lastVoiceAt = 0;
  /** Continuously-calibrated ambient RMS. Seeded on arm, adapts on quiet frames. */
  private noiseFloor = 0.01;
  /** performance.now() when the current segment's recorder started. */
  private segmentStartedAt = 0;
  /** Opt-in console tracing: localStorage.setItem('voiceVadDebug','1'). */
  private vadDebug = false;
  private vadDebugTick = 0;

  ngOnDestroy(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.teardownHandsFree();
    this.stopStream();
  }

  /* ================================================================== */
  /*  Push-to-talk (latency-critical — do not add pre-record work here)  */
  /* ================================================================== */

  async onPressStart(event?: Event) {
    event?.preventDefault();
    // Hands-free owns the mic while armed — the main button is a passive
    // indicator then, toggled only via the separate "live" control.
    if (this.handsFree()) return;
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
    if (this.handsFree()) return;
    this.onPressEnd(event);
  }

  onPressEnd(event?: Event) {
    event?.preventDefault();
    if (this.handsFree()) return;
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

  /* ================================================================== */
  /*  Hands-free listening (VAD)                                          */
  /* ================================================================== */

  /** Toggle the separate "live" control. Arms / disarms hands-free mode. */
  async toggleHandsFree(event?: Event) {
    event?.preventDefault();
    if (this.handsFree()) {
      this.teardownHandsFree();
      this.state.set('idle');
      this.cdr.markForCheck();
      return;
    }
    // Don't arm in the middle of a push-to-talk capture.
    if (this.state() !== 'idle') return;
    await this.armHandsFree();
  }

  private async armHandsFree() {
    this.lastError.set(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.hfStream = stream;
      const Ctx: typeof AudioContext =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new Ctx();
      try { await this.audioCtx.resume(); } catch { /* already running */ }
      const src = this.audioCtx.createMediaStreamSource(stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.vadData = new Float32Array(new ArrayBuffer(this.analyser.fftSize * Float32Array.BYTES_PER_ELEMENT));
      src.connect(this.analyser);

      this.segmentActive = false;
      this.voicedMs = 0;
      // Seed the noise floor low; the first few quiet frames calibrate it up to
      // the real ambient level before the user starts speaking.
      this.noiseFloor = 0.01;
      try { this.vadDebug = localStorage.getItem('voiceVadDebug') === '1'; } catch { this.vadDebug = false; }
      this.vadDebugTick = 0;
      this.handsFree.set(true);
      this.vadTimer = setInterval(() => this.vadTick(), VoiceMicButtonComponent.VAD_POLL_MS);
      this.cdr.markForCheck();
    } catch (err) {
      this.teardownHandsFree();
      this.handleError(err);
    }
  }

  /** Polled ~20×/s: measures input level and drives segment start/stop.
   *
   *  Detection is RELATIVE, not a fixed threshold: a frame is "speech" when its
   *  RMS rises well above a continuously-calibrated ambient noise floor. This
   *  works across mics/gain/background without per-device tuning — the previous
   *  fixed 0.02 threshold sat below many mics' noise floor, so every frame read
   *  as speech and the silence trigger never fired. */
  private vadTick() {
    if (!this.analyser || !this.vadData) return;
    this.analyser.getFloatTimeDomainData(this.vadData);
    let sum = 0;
    for (let i = 0; i < this.vadData.length; i++) {
      const v = this.vadData[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.vadData.length);
    const now = performance.now();

    const dynThreshold = Math.max(
      this.vadThreshold(),
      this.noiseFloor * VoiceMicButtonComponent.SPEECH_RATIO,
    );
    const speaking = rms >= dynThreshold;

    if (this.vadDebug && (this.vadDebugTick++ % 4 === 0)) {
      console.log('[vad]', {
        rms: +rms.toFixed(4),
        floor: +this.noiseFloor.toFixed(4),
        thr: +dynThreshold.toFixed(4),
        speaking,
        seg: this.segmentActive,
        silentMs: this.segmentActive ? Math.round(now - this.lastVoiceAt) : 0,
      });
    }

    if (speaking) {
      this.lastVoiceAt = now;
      if (!this.segmentActive) this.startSegment();
      this.voicedMs += VoiceMicButtonComponent.VAD_POLL_MS;
      // Safety: a mic that never returns to "silence" (constant noise above the
      // floor) would otherwise hang the segment open forever — force-flush it.
      if (now - this.segmentStartedAt >= VoiceMicButtonComponent.MAX_SEGMENT_MS) {
        if (this.vadDebug) console.log('[vad] max-segment reached — flushing');
        this.stopSegment();
      }
      return;
    }

    // Not speech → let the ambient floor track the current quiet level so the
    // detector adapts to changing background noise.
    this.noiseFloor =
      this.noiseFloor * (1 - VoiceMicButtonComponent.NOISE_EMA) +
      rms * VoiceMicButtonComponent.NOISE_EMA;

    // Close the utterance once the trailing silence exceeds the threshold.
    if (this.segmentActive && now - this.lastVoiceAt >= this.silenceMs()) {
      if (this.voicedMs >= VoiceMicButtonComponent.MIN_SPEECH_MS) {
        if (this.vadDebug) console.log('[vad] silence → finalize segment', { voicedMs: this.voicedMs });
        this.stopSegment();          // → finalizeSegment via onstop
      } else {
        this.abortSegment();         // too short — drop noise, keep listening
      }
    }
  }

  private startSegment() {
    if (!this.hfStream) return;
    const mimeType = this.pickMime();
    this.hfRecorder = mimeType
      ? new MediaRecorder(this.hfStream, { mimeType })
      : new MediaRecorder(this.hfStream);
    this.hfChunks = [];
    this.hfRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.hfChunks.push(ev.data);
    };
    this.hfRecorder.onstop = () => this.finalizeSegment();
    this.hfRecorder.start(250);
    this.segmentActive = true;
    this.segmentStartedAt = performance.now();
    this.voicedMs = 0;
    this.listening.set(true);
    this.state.set('recording');
    this.cdr.markForCheck();
  }

  private stopSegment() {
    this.segmentActive = false;
    this.listening.set(false);
    try {
      if (this.hfRecorder && this.hfRecorder.state === 'recording') {
        try { this.hfRecorder.requestData(); } catch { /* noop */ }
        this.hfRecorder.stop();
      }
    } catch (err) {
      this.handleError(err);
    }
  }

  /** Discard a too-short segment without an STT round-trip; keep listening. */
  private abortSegment() {
    this.segmentActive = false;
    this.voicedMs = 0;
    this.listening.set(false);
    const rec = this.hfRecorder;
    this.hfRecorder = null;
    this.hfChunks = [];
    try {
      if (rec && rec.state === 'recording') {
        rec.onstop = null;
        rec.stop();
      }
    } catch { /* noop */ }
    if (this.handsFree() && this.state() === 'recording') this.state.set('idle');
    this.cdr.markForCheck();
  }

  private async finalizeSegment() {
    const mimeType = this.hfRecorder?.mimeType || 'audio/webm';
    const blob = new Blob(this.hfChunks, { type: mimeType });
    this.hfRecorder = null;
    this.hfChunks = [];
    // Disarmed mid-flight — drop the result, the stream is already gone.
    if (!this.handsFree()) return;

    this.state.set('transcribing');
    this.cdr.markForCheck();
    try {
      const res = await this.api.stt(blob, {
        language: this.language() || undefined,
        task: 'transcribe',
        filename: `segment.${this.extFor(mimeType)}`,
      });
      if (!res.ok) {
        this.lastError.set(res.error || 'Transcription failed');
        this.errorMessage.emit(this.lastError()!);
      } else {
        const text = (res.text || '').trim();
        if (this.vadDebug) console.log('[vad] STT result', JSON.stringify(text));
        if (text) {
          this.lastText.set(text);
          this.autoSend.emit(text);
        }
      }
    } catch (err) {
      // Surface but stay armed — a single failed segment shouldn't end the
      // hands-free session.
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError.set(msg);
      this.errorMessage.emit(msg);
    } finally {
      // Back to waiting for the next utterance on the still-open stream.
      if (this.handsFree()) this.state.set('idle');
      this.cdr.markForCheck();
    }
  }

  private teardownHandsFree() {
    this.handsFree.set(false);
    this.listening.set(false);
    this.segmentActive = false;
    this.voicedMs = 0;
    if (this.vadTimer) { clearInterval(this.vadTimer); this.vadTimer = null; }
    try {
      if (this.hfRecorder && this.hfRecorder.state === 'recording') {
        this.hfRecorder.onstop = null;
        this.hfRecorder.stop();
      }
    } catch { /* noop */ }
    this.hfRecorder = null;
    this.hfChunks = [];
    try { void this.audioCtx?.close(); } catch { /* noop */ }
    this.audioCtx = null;
    this.analyser = null;
    this.vadData = null;
    try { this.hfStream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    this.hfStream = null;
  }

  /* ---- Shared helpers ---- */

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
