import { ChangeDetectionStrategy, ChangeDetectorRef, Component, CUSTOM_ELEMENTS_SCHEMA, OnDestroy, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { VoiceApiService } from '../../services/voice-api.service';

type DictaphoneState = 'idle' | 'recording' | 'recorded' | 'transcribing' | 'saving' | 'saved';

/** A single file currently being imported via the drag-and-drop zone. The list
 *  is independent of the recording state machine — multiple imports may run in
 *  parallel without affecting the dictaphone's record/save flow. */
interface ImportJob {
  readonly id: string;
  readonly fileName: string;
  readonly fileSize: number;
  status: 'queued' | 'uploading' | 'transcoding' | 'done' | 'error';
  noteId?: string;
  noteTitle?: string;
  transcript?: string;
  language?: string | null;
  errorMessage?: string;
}

/**
 * Dictaphone — records audio in the browser, lets the user preview, transcribes
 * via /voice-api/api/stt, and on Save uploads the audio to core's
 * `/api/files/uploadDirect` then creates a `voice_notes` row pointing at the
 * resulting file.
 *
 * State machine: idle → recording → recorded → (transcribing in background)
 *   recorded → saving → saved → idle (reset)
 *   recorded → idle (discard)
 */
@Component({
  selector: 'voice-dictaphone',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './voice-dictaphone.html',
  styleUrl: './voice-dictaphone.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class VoiceDictaphoneComponent implements OnDestroy {
  private readonly api = inject(VoiceApiService);
  private readonly http = inject(HttpClient);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly windowId = input<string>('');
  readonly language = input<string | null>(null);

  state = signal<DictaphoneState>('idle');
  errorMessage = signal<string | null>(null);

  /** Editable note title. Pre-filled with capture timestamp on stop. */
  title = signal<string>('');
  /** Editable transcript. Auto-filled by STT, user-editable before save. */
  transcript = signal<string>('');
  /** ISO 639-1 detected during STT. */
  detectedLanguage = signal<string | null>(null);
  /** Recording duration in ms (computed from elapsed wall-clock). */
  durationMs = signal<number>(0);
  /** Object URL for the recorded blob — bound to the <audio> player. */
  audioUrl = signal<string | null>(null);

  /** Recently saved notes (in-session log so the user sees a result). */
  recent = signal<readonly { id: string; title: string; at: number }[]>([]);

  /** Optional language hint applied to BOTH recording-STT and drop-zone imports.
   *  Empty string = auto-detect. Overrides the `language` component input when set. */
  selectedLanguage = signal<string>('');

  /** Languages offered in the optional selector. Keep small — faster-whisper
   *  supports ~100 but exposing them all is overwhelming. Empty value = auto. */
  readonly languageOptions: ReadonlyArray<{ code: string; label: string }> = [
    { code: '',   label: 'Auto-detect' },
    { code: 'hu', label: 'Magyar' },
    { code: 'en', label: 'English' },
    { code: 'de', label: 'Deutsch' },
    { code: 'es', label: 'Español' },
    { code: 'fr', label: 'Français' },
    { code: 'it', label: 'Italiano' },
    { code: 'pt', label: 'Português' },
    { code: 'nl', label: 'Nederlands' },
    { code: 'pl', label: 'Polski' },
    { code: 'ro', label: 'Română' },
    { code: 'sk', label: 'Slovenčina' },
    { code: 'cs', label: 'Čeština' },
    { code: 'ru', label: 'Русский' },
    { code: 'uk', label: 'Українська' },
    { code: 'tr', label: 'Türkçe' },
    { code: 'ja', label: '日本語' },
    { code: 'zh', label: '中文' },
  ];

  /** Effective language hint: user selection wins, then the component input,
   *  then nothing (let faster-whisper auto-detect). */
  effectiveLanguage(): string | null {
    const sel = this.selectedLanguage();
    if (sel) return sel;
    return this.language() || null;
  }

  /** In-flight & recently finished imports from the drag-and-drop zone. */
  imports = signal<readonly ImportJob[]>([]);
  /** Drag-state for the drop zone — toggled by document-level dragenter/leave
   *  counters so styling doesn't flicker when crossing nested child elements. */
  isDraggingOver = signal<boolean>(false);
  private dragDepth = 0;

  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private mutedGain: GainNode | null = null;
  private pcmChunks: Float32Array[] = [];
  private captureSampleRate = 48000;
  private recordedBlob: Blob | null = null;
  private recordedMime: string = 'audio/wav';
  private recordingStart = 0;

  ngOnDestroy(): void {
    this.stopStream();
    this.revokeAudioUrl();
  }

  async startRecording(): Promise<void> {
    if (this.state() !== 'idle' && this.state() !== 'saved') return;
    this.resetCapture();
    this.errorMessage.set(null);
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      // Capture raw PCM via Web Audio API so we can save lossless WAV.
      // MediaRecorder only emits compressed opus/webm in most browsers, which
      // degrades downstream voice cloning. ScriptProcessorNode is deprecated
      // but universally supported; for short dictaphone takes the main-thread
      // overhead is negligible.
      const Ctor: typeof AudioContext =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new Ctor();
      this.captureSampleRate = this.audioContext.sampleRate;
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.pcmChunks = [];
      this.processorNode.onaudioprocess = (ev) => {
        // Copy the channel data — the underlying buffer is reused by the API.
        const ch = ev.inputBuffer.getChannelData(0);
        this.pcmChunks.push(new Float32Array(ch));
      };
      // Route through a muted gain so the processor fires in browsers that
      // require a path to destination, without echoing the mic to speakers.
      this.mutedGain = this.audioContext.createGain();
      this.mutedGain.gain.value = 0;
      this.sourceNode.connect(this.processorNode);
      this.processorNode.connect(this.mutedGain);
      this.mutedGain.connect(this.audioContext.destination);
      this.recordingStart = Date.now();
      this.state.set('recording');
      this.cdr.markForCheck();
    } catch (err) {
      this.handleError(err);
    }
  }

  stopRecording(): void {
    if (this.state() !== 'recording') return;
    try {
      this.finalizeRecording();
    } catch (err) {
      this.handleError(err);
    }
  }

  /** Re-record: discard current take and start fresh. */
  async retake(): Promise<void> {
    this.resetCapture();
    await this.startRecording();
  }

  /** Throw away the current recording without saving. */
  discard(): void {
    this.resetCapture();
    this.state.set('idle');
    this.cdr.markForCheck();
  }

  async save(): Promise<void> {
    if (this.state() !== 'recorded' && this.state() !== 'transcribing') return;
    if (!this.recordedBlob) {
      this.errorMessage.set('No recording to save.');
      return;
    }
    const title = (this.title() || '').trim() || this.defaultTitle();
    this.state.set('saving');
    this.errorMessage.set(null);
    this.cdr.markForCheck();

    try {
      // 1. Upload audio blob to core files collection.
      const filename = `voice-note-${Date.now()}.${this.extFor(this.recordedMime)}`;
      const form = new FormData();
      form.append('file', this.recordedBlob, filename);
      form.append('title', title);
      form.append('kind', 'file');
      form.append('visibility', 'private');
      const fileDoc = await firstValueFrom(
        this.http.post<{ _id: string }>('/api/files/uploadDirect', form),
      );
      const audioFileId = (fileDoc as any)?._id;
      if (!audioFileId) throw new Error('File upload did not return an _id.');

      // 2. Create voice_notes row pointing at the file.
      const row = {
        title,
        audioFileId,
        transcript: (this.transcript() || '').trim(),
        language: this.detectedLanguage() || undefined,
        durationMs: this.durationMs(),
        mimeType: this.recordedMime,
      };
      const created = await firstValueFrom(
        this.http.post<{ _id: string }>('/api/dynamic/voice_notes', row),
      );
      const noteId = (created as any)?._id || '';

      this.recent.update((prev) => [{ id: noteId, title, at: Date.now() }, ...prev].slice(0, 10));
      this.state.set('saved');
      // Clear the working take so the UI shows the success message.
      this.resetCapture();
      this.cdr.markForCheck();
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : String(err));
      // Keep the recording around so the user can retry Save.
      this.state.set('recorded');
      this.cdr.markForCheck();
    }
  }

  private finalizeRecording(): void {
    // Detach the Web Audio graph BEFORE encoding so no more chunks arrive.
    try { this.processorNode?.disconnect(); } catch { /* noop */ }
    try { this.sourceNode?.disconnect(); } catch { /* noop */ }
    try { this.mutedGain?.disconnect(); } catch { /* noop */ }

    const mimeType = 'audio/wav';
    const blob = encodePcmToWav(this.pcmChunks, this.captureSampleRate);
    this.pcmChunks = [];
    this.recordedMime = mimeType;
    this.recordedBlob = blob;
    this.durationMs.set(Date.now() - this.recordingStart);
    this.revokeAudioUrl();
    this.audioUrl.set(URL.createObjectURL(blob));
    this.stopStream();

    // Pre-fill the title with a timestamp so saving requires zero typing.
    if (!this.title().trim()) {
      this.title.set(this.defaultTitle());
    }

    // Show the player + Save UI immediately while STT runs in parallel.
    this.state.set('recorded');
    this.cdr.markForCheck();
    void this.transcribeInBackground(blob, mimeType);
  }

  private async transcribeInBackground(blob: Blob, mimeType: string): Promise<void> {
    // Only flip to the 'transcribing' shade if we're still on the same take.
    if (this.state() !== 'recorded') return;
    this.state.set('transcribing');
    this.cdr.markForCheck();
    try {
      const res = await this.api.stt(blob, {
        language: this.effectiveLanguage() || undefined,
        task: 'transcribe',
        filename: `recording.${this.extFor(mimeType)}`,
      });
      // The user may have already hit Discard/Save/Retake — only apply if we
      // still have the same blob loaded and haven't moved past 'transcribing'.
      if (this.recordedBlob !== blob) return;
      if (res.ok) {
        if (!this.transcript().trim()) {
          this.transcript.set((res.text || '').trim());
        }
        if (res.language) this.detectedLanguage.set(res.language);
      } else {
        // Don't block the save — transcript is optional.
        this.errorMessage.set(res.error || 'Transcription failed (you can still save).');
      }
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : String(err));
    } finally {
      if (this.recordedBlob === blob && this.state() === 'transcribing') {
        this.state.set('recorded');
        this.cdr.markForCheck();
      }
    }
  }

  private defaultTitle(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `Voice note ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private resetCapture(): void {
    this.revokeAudioUrl();
    this.recordedBlob = null;
    this.pcmChunks = [];
    this.title.set('');
    this.transcript.set('');
    this.detectedLanguage.set(null);
    this.durationMs.set(0);
  }

  private revokeAudioUrl(): void {
    const url = this.audioUrl();
    if (url) {
      try { URL.revokeObjectURL(url); } catch { /* noop */ }
      this.audioUrl.set(null);
    }
  }

  private stopStream(): void {
    try { this.mediaStream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    this.mediaStream = null;
    try { this.audioContext?.close(); } catch { /* noop */ }
    this.audioContext = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.mutedGain = null;
  }

  private handleError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.errorMessage.set(msg);
    this.state.set('idle');
    this.stopStream();
    this.cdr.markForCheck();
  }

  private extFor(mime: string): string {
    if (mime.startsWith('audio/wav')) return 'wav';
    if (mime.startsWith('audio/webm')) return 'webm';
    if (mime.startsWith('audio/ogg')) return 'ogg';
    if (mime.startsWith('audio/mp4')) return 'm4a';
    return 'bin';
  }

  formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------------------------
  // Drag-and-drop import zone — accepts any media file, transcodes to WAV on
  // the backend, runs STT, then creates a voice_notes row. Each file becomes
  // its own ImportJob in `imports()` so the user gets per-file feedback.
  // ---------------------------------------------------------------------------

  onDragEnter(ev: DragEvent): void {
    if (!this.hasFiles(ev)) return;
    ev.preventDefault();
    this.dragDepth += 1;
    this.isDraggingOver.set(true);
  }

  onDragOver(ev: DragEvent): void {
    if (!this.hasFiles(ev)) return;
    // Required so the browser actually fires drop instead of opening the file.
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  }

  onDragLeave(ev: DragEvent): void {
    if (!this.hasFiles(ev)) return;
    ev.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.isDraggingOver.set(false);
  }

  onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.dragDepth = 0;
    this.isDraggingOver.set(false);
    const files = ev.dataTransfer?.files;
    if (!files || files.length === 0) return;
    this.queueImports(Array.from(files));
  }

  onPickFiles(ev: Event): void {
    const input = ev.target as HTMLInputElement | null;
    const files = input?.files;
    if (files && files.length > 0) this.queueImports(Array.from(files));
    if (input) input.value = ''; // allow re-selecting the same file
  }

  removeImport(id: string): void {
    this.imports.update((prev) => prev.filter((j) => j.id !== id));
  }

  private hasFiles(ev: DragEvent): boolean {
    const types = ev.dataTransfer?.types;
    return !!types && Array.from(types).includes('Files');
  }

  private queueImports(files: readonly File[]): void {
    for (const file of files) {
      const id = `imp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const job: ImportJob = {
        id,
        fileName: file.name || 'upload',
        fileSize: file.size,
        status: 'queued',
      };
      this.imports.update((prev) => [job, ...prev].slice(0, 20));
      void this.runImport(id, file);
    }
  }

  private async runImport(id: string, file: File): Promise<void> {
    this.updateImport(id, { status: 'uploading' });
    const form = new FormData();
    form.append('file', file, file.name);
    const lang = this.effectiveLanguage();
    if (lang) form.append('language', lang);
    // The whole job is upload + ffmpeg + STT + save on the backend. We can't
    // distinguish those phases over a single HTTP request, so we flip to
    // 'transcoding' shortly after upload starts to communicate that work
    // is happening server-side.
    //
    // Critical: the timer MUST be cleared on BOTH success and failure paths,
    // otherwise a fast-failing backend (e.g. ffmpeg rejecting a video-only
    // MP4 in 150ms) leaves the timer armed → 800ms later it overwrites the
    // error status back to 'transcoding' and the row appears stuck forever.
    // Hoist the handle so `finally` can always cancel it.
    let transcodeTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      // Only flip to transcoding if we're still mid-flight — the job may
      // already have reached a terminal state (error/done) in between.
      const job = this.imports().find((j) => j.id === id);
      if (job && job.status === 'uploading') {
        this.updateImport(id, { status: 'transcoding' });
      }
    }, 800);
    try {
      const res = await firstValueFrom(
        this.http.post<{
          ok: boolean;
          noteId?: string;
          title?: string;
          transcript?: string;
          language?: string | null;
          error?: string;
          detail?: string;
        }>('/voice-api/api/import-media', form),
      );
      if (!res || res.ok === false) {
        this.updateImport(id, {
          status: 'error',
          errorMessage: res?.detail || res?.error || 'Import failed.',
        });
        return;
      }
      this.updateImport(id, {
        status: 'done',
        noteId: res.noteId,
        noteTitle: res.title,
        transcript: res.transcript,
        language: res.language ?? null,
      });
      if (res.noteId && res.title) {
        this.recent.update((prev) =>
          [{ id: res.noteId!, title: res.title!, at: Date.now() }, ...prev].slice(0, 10),
        );
      }
    } catch (err) {
      this.updateImport(id, {
        status: 'error',
        errorMessage: this.formatImportError(err),
      });
    } finally {
      if (transcodeTimer !== null) {
        clearTimeout(transcodeTimer);
        transcodeTimer = null;
      }
      this.cdr.markForCheck();
    }
  }

  /** Extract a human-readable message from whatever HttpClient throws.
   *  HttpErrorResponse is NOT an Error subclass and `String()` returns
   *  '[object Object]', so we must check for the parsed JSON body and the
   *  backend's `{error, detail}` envelope explicitly. */
  private formatImportError(err: unknown): string {
    if (err && typeof err === 'object') {
      const anyErr = err as { error?: unknown; message?: string; statusText?: string; status?: number };
      const body = anyErr.error;
      if (body && typeof body === 'object') {
        const b = body as { error?: string; detail?: string; message?: string };
        const msg = b.detail || b.error || b.message;
        if (msg) return msg;
      }
      if (typeof body === 'string' && body.trim()) return body;
      if (typeof anyErr.message === 'string' && anyErr.message) return anyErr.message;
      if (typeof anyErr.statusText === 'string' && anyErr.statusText) {
        return `${anyErr.status ?? ''} ${anyErr.statusText}`.trim();
      }
    }
    if (err instanceof Error) return err.message;
    return String(err);
  }

  private updateImport(id: string, patch: Partial<ImportJob>): void {
    this.imports.update((prev) =>
      prev.map((j) => (j.id === id ? ({ ...j, ...patch } as ImportJob) : j)),
    );
    this.cdr.markForCheck();
  }

  formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
}

/**
 * Encode an array of Float32Array PCM chunks (mono, native sample rate) into a
 * 16-bit little-endian WAV Blob. Output is lossless and decoded cleanly by
 * torchaudio's soundfile backend — no ffmpeg/opus round-trip in the pipeline,
 * so cloned voices preserve timbre.
 */
function encodePcmToWav(chunks: readonly Float32Array[], sampleRate: number): Blob {
  let totalSamples = 0;
  for (const c of chunks) totalSamples += c.length;

  const merged = new Float32Array(totalSamples);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }

  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = merged.length * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);          // chunk size
  view.setUint16(20, 1, true);           // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // PCM samples — clamp to [-1, 1] then scale to int16 range.
  let p = 44;
  for (let i = 0; i < merged.length; i += 1) {
    let s = merged[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    p += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i += 1) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
