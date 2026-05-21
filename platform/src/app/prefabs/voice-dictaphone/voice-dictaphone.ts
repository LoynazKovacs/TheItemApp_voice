import { ChangeDetectionStrategy, ChangeDetectorRef, Component, CUSTOM_ELEMENTS_SCHEMA, OnDestroy, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { VoiceApiService } from '../../services/voice-api.service';

type DictaphoneState = 'idle' | 'recording' | 'recorded' | 'transcribing' | 'saving' | 'saved';

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

  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private recordedBlob: Blob | null = null;
  private recordedMime: string = 'audio/webm';
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
      this.mediaRecorder?.stop();
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

  private async finalizeRecording(): Promise<void> {
    const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type: mimeType });
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
        language: this.language() || undefined,
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
    this.chunks = [];
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
    this.mediaRecorder = null;
  }

  private handleError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.errorMessage.set(msg);
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

  formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
  }
}
