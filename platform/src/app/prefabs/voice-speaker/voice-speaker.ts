import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, computed, effect, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VoiceApiService } from '../../services/voice-api.service';
import { RefResolverService } from '../../services/ref-resolver.service';
import { UserVoicePrefsService } from '../../services/user-voice-prefs.service';

/**
 * Strip markdown / agent-protocol noise that doesn't read well in TTS:
 *  - chip-ref tokens like `coding_agent_repos/6a0b2f5987da4709ea3c4b5e`
 *    (the UI renders these as clickable pills — the TTS engine would
 *    otherwise spell them character-by-character)
 *  - inline code spans (commit SHAs, code snippets, identifiers)
 *  - bare hex tokens of 7+ chars (commit SHAs sitting outside backticks)
 *  - URLs (read as a stream of letters and slashes)
 *  - markdown emphasis markers (**bold**, *italic*, __u__, _u_)
 *  - bullet / heading / blockquote line prefixes
 *  - em-dash / line-leading dashes that get vocalised as "dash"
 *  - collapse runs of whitespace inside a line
 *
 * Operates per-chunk so the cursor in the original raw text is unaffected.
 */
export function sanitizeForTts(input: string, refLabels?: Map<string, string> | Record<string, string>): string {
  let s = input;
  const lookup = (ref: string): string | undefined => {
    if (!refLabels) return undefined;
    if (refLabels instanceof Map) return refLabels.get(ref) || refLabels.get(ref.toLowerCase());
    return refLabels[ref] || refLabels[ref.toLowerCase()];
  };
  // Chip refs: optional surrounding parens. If we have a friendly label
  // cached for the ref, substitute it so the listener hears the record's
  // name; otherwise strip silently (avoids spelling out 24 hex chars).
  s = s.replace(/\(\s*([a-z_][a-z0-9_]*\/[0-9a-f]{24})\s*\)/gi, (_m, ref: string) => {
    const label = lookup(ref);
    return label ? `(${label})` : '';
  });
  s = s.replace(/[a-z_][a-z0-9_]*\/[0-9a-f]{24}/gi, (m: string) => {
    const label = lookup(m);
    return label ? label : '';
  });
  // Inline code spans. Most of the time the content is a short identifier
  // (variable name, file name, voice name like `af_bella`) that should be
  // read aloud — just unwrap the backticks. Only drop the span entirely
  // when the content looks like genuine code/shell noise that TTS will
  // butcher: shell pipelines, function-call syntax, pure-hex blobs, etc.
  s = s.replace(/`([^`]+)`/g, (_m, inner: string) => {
    const t = inner.trim();
    // Pure hex (likely commit SHA / ObjectId fragment) → drop. The bare-hex
    // pass below will also catch these once unwrapped, but dropping here
    // keeps surrounding punctuation cleaner.
    if (/^[0-9a-f]{7,}$/i.test(t) && /\d/.test(t)) return '';
    // Code-ish: shell syntax, function calls with args, multi-token commands
    // with operators/redirects, semicolons. These read horribly.
    if (/[(){};|&]/.test(t)) return '';
    if (/\s/.test(t) && /[/=<>$@]/.test(t)) return '';
    // Otherwise keep the inner text (identifier-like, file name, etc.).
    return inner;
  });
  // Bare hex SHA-like tokens (7-40 hex chars, must contain at least one digit
  // OR be at least 7 chars — avoid swallowing real English hex-only words).
  s = s.replace(/\b[0-9a-f]{7,40}\b/gi, m => /\d/.test(m) ? '' : m);
  // URLs.
  s = s.replace(/https?:\/\/\S+/gi, '');
  // Markdown emphasis (keep inner text).
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, '$1');
  s = s.replace(/(?<![\w_])_(?!\s)([^_\n]+?)_(?![\w_])/g, '$1');
  // Strip line-leading bullets / headings / blockquotes / em-dashes.
  s = s.replace(/^[ \t]*[-*•][ \t]+/gm, '');
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  s = s.replace(/^[ \t]*>+[ \t]?/gm, '');
  s = s.replace(/^[ \t]*[—–-][ \t]+/gm, '');
  // Collapse horizontal whitespace runs.
  s = s.replace(/[ \t]+/g, ' ');
  // Collapse blank-line runs to a single blank line.
  s = s.replace(/\n{3,}/g, '\n\n');
  return s;
}

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
  private readonly refs = inject(RefResolverService);
  private readonly prefs = inject(UserVoicePrefsService);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly windowId = input<string>('');
  readonly text = input<string>('');
  readonly voice = input<string | null>(null);
  readonly format = input<'mp3' | 'wav' | 'opus' | 'flac' | 'aac' | 'pcm'>('mp3');
  readonly speed = input<number>(1.0);
  readonly label = input<string>('Speak');
  /**
   * When `true`, the button behaves as a toggle:
   *  - First click ARMS the speaker (visually highlighted) and plays the
   *    current `text()` immediately.
   *  - While armed, every subsequent change of `text()` to a new non-empty
   *    value is spoken automatically.
   *  - Next click DISARMS, stops any ongoing playback, and reverts to idle.
   *
   * When `false` (default), the original one-shot behaviour is preserved
   * for stand-alone consumers (e.g. voice-studio).
   */
  readonly autoMode = input<boolean>(false);
  /**
   * When `true`, the speaker treats `text()` as a growing buffer (assistant
   * message currently streaming) and only extracts COMPLETE sentences from
   * past the last-consumed cursor — synthesising and playing each as soon
   * as it arrives, well before the full reply is finished rendering.
   *
   * When this transitions back to `false` while there's still un-consumed
   * tail past the cursor, the remainder is flushed as a final chunk.
   *
   * Only meaningful in conjunction with `autoMode === true`.
   */
  readonly streaming = input<boolean>(false);

  state = signal<'idle' | 'loading' | 'playing'>('idle');
  lastError = signal<string | null>(null);
  /** True while auto-mode is engaged. Only meaningful when autoMode()===true. */
  armed = signal<boolean>(false);

  /**
   * Effective OmniVoice profile id used for TTS calls.
   *
   * Precedence:
   *  1. Explicit `voice` input (caller / slot config wins).
   *  2. User's pref from `user_ui_configs.voice.selectedVoiceId` (resolved
   *     to `voice_voices.profileId` by UserVoicePrefsService).
   *  3. `undefined` → backend falls back to `VOICE_DEFAULT_VOICE` env var.
   */
  private readonly effectiveVoice = computed<string | undefined>(() => {
    const explicit = this.voice();
    if (explicit) return explicit;
    return this.prefs.profileId() ?? undefined;
  });

  private currentAudio: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;
  /** Tracks the last text we played in auto-mode to avoid replays on no-op changes. */
  private lastAutoSpoken = '';
  /**
   * Monotonically increments whenever a new playback "job" is started. Long
   * playbacks (chunked text) check this token between chunks and abort if the
   * user has stopped/restarted the speaker — prevents stale chunks playing
   * after a manual stop or a fresher assistant reply.
   */
  private jobId = 0;

  /* ---- Streaming-queue state (auto-mode only) ----------------------- */
  /** Characters of text() already extracted into the streamQueue. */
  private streamCursor = 0;
  /** First ~64 chars of the text() value we last advanced past — used to
   *  detect "different message" vs "continuation". */
  private streamPrefix = '';
  /** FIFO of chunk strings waiting to be synthesised + played. */
  private streamQueue: string[] = [];
  /** True while the pump loop is running. */
  private pumping = false;

  /**
   * Cache of chip-ref → display label. Populated on demand by
   * `ensureRefsResolved()`. Misses (record not found / unauthorized) are
   * stored as empty string so we don't re-fetch them on every chunk.
   */
  private readonly refCache = new Map<string, string>();
  /**
   * Serialises async ref-resolution + queue pushes inside the streaming
   * effect so chunks remain in arrival order even when one slice's resolve
   * promise takes longer than the next's.
   */
  private sliceChain: Promise<void> = Promise.resolve();

  constructor() {
    // Trigger lazy load of user voice prefs. Safe to fire from constructor —
    // shared singleton dedupes the actual HTTP call. The first TTS request
    // may race with the load and fall back to the backend default voice;
    // subsequent requests see the resolved profileId.
    void this.prefs.ensureLoaded();

    // Streaming extractor: watches text() (and streaming() flag) while armed
    // and queues newly-arrived complete sentences for playback.
    effect(() => {
      if (!this.autoMode() || !this.armed()) return;
      const raw = this.text() || '';
      const isStreaming = this.streaming();

      // --- Detect reset vs. continuation ---
      // The text feeding us can shrink WITHOUT being a new message — e.g. the
      // parent switches `lastAssistantText` from the streaming buffer (may
      // include trailing whitespace) to the finalised timeline entry (trimmed).
      // Treat as "same message, shorter" iff the new raw is still a prefix of
      // what we've seen — that means everything past raw.length was just
      // whitespace/trim, and the cursor should be capped (not rewound).
      // Otherwise it's a genuinely different message → soft reset.
      if (this.streamPrefix) {
        const cmpLen = Math.min(this.streamPrefix.length, raw.length);
        const sameStart = cmpLen > 0 && raw.startsWith(this.streamPrefix.substring(0, cmpLen));
        if (!sameStart) {
          // Truly different message — drain pending chunks, but let any
          // currently-playing audio finish naturally so we don't cut the
          // previous message mid-word.
          this.softResetStream();
        } else if (raw.length < this.streamCursor) {
          // Same message, just shorter (trim). Cap cursor so we don't
          // re-speak the already-consumed tail.
          this.streamCursor = raw.length;
        }
      } else if (raw.length < this.streamCursor) {
        // Edge case (no prefix yet): cap to prevent re-speak.
        this.streamCursor = raw.length;
      }

      const remaining = raw.substring(this.streamCursor);
      if (!remaining) return;

      // --- Find safe split point ---
      let splitAt = -1;
      if (!isStreaming) {
        // Streaming ended → flush whatever's left as the final chunk.
        splitAt = remaining.length;
      } else {
        // Look for last sentence-end punctuation followed by whitespace,
        // or a paragraph break.
        const re = /[.!?]+["')\]]*\s+/g;
        let lastEnd = -1;
        let m: RegExpExecArray | null;
        while ((m = re.exec(remaining)) !== null) {
          lastEnd = m.index + m[0].length;
        }
        const para = remaining.lastIndexOf('\n\n');
        if (para >= 0) lastEnd = Math.max(lastEnd, para + 2);
        // Fallback: if no sentence/paragraph break found AND the remaining
        // buffer is getting long, split at the last single-line break.
        // Without this, markdown bullet lists (no `. ` between bullets)
        // accumulate as one giant chunk, creating long silence gaps.
        if (lastEnd <= 0 && remaining.length > 140) {
          const nl = remaining.lastIndexOf('\n');
          if (nl > 0) lastEnd = nl + 1;
        }
        if (lastEnd > 0) splitAt = lastEnd;
      }

      if (splitAt <= 0) return;
      const rawSlice = remaining.substring(0, splitAt);
      // Cursor advances along the RAW text — sanitisation only affects what
      // we send to TTS, not what we consider "consumed". We bump the cursor
      // synchronously here so the effect doesn't re-fire on the same slice
      // while we're awaiting ref resolution.
      this.streamCursor += splitAt;
      this.streamPrefix = raw.substring(0, Math.min(64, raw.length));
      const jobAtQueue = this.jobId;
      // Chain the ref-resolution + queue push so chunks remain in order
      // even when one slice's resolve takes longer than the next.
      this.sliceChain = this.sliceChain.then(async () => {
        if (this.jobId !== jobAtQueue || !this.armed()) return;
        await this.ensureRefsResolved(rawSlice);
        if (this.jobId !== jobAtQueue || !this.armed()) return;
        const chunkText = sanitizeForTts(rawSlice, this.refCache).trim();
        // Skip chunks with no speakable letters (TTS engines choke on "---"
        // etc., and post-sanitisation a chunk that was pure IDs/code may end
        // up empty — silently drop those).
        if (!chunkText || !/\p{L}|\p{N}/u.test(chunkText)) return;
        this.streamQueue.push(chunkText);
        void this.kickPump();
      }).catch(() => { /* swallow — keep chain alive */ });
    });
  }

  /**
   * Find every `modelKey/24hex` chip ref in `text` and resolve them via the
   * frontend `RefResolverService` (mirrors the chip renderer's
   * `ui.display.templates` so what the listener hears matches what they see).
   * Misses are stored as empty string sentinel so the sanitiser strips them
   * silently without re-fetching.
   */
  private async ensureRefsResolved(text: string): Promise<void> {
    if (!text) return;
    const REF_RE = /[a-z_][a-z0-9_]*\/[0-9a-f]{24}/gi;
    const found: string[] = [];
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = REF_RE.exec(text)) !== null) {
      const ref = m[0];
      if (seen.has(ref) || this.refCache.has(ref)) continue;
      seen.add(ref);
      found.push(ref);
    }
    if (!found.length) return;
    const labels = await this.refs.resolve(found);
    for (const ref of found) {
      const label = labels.get(ref);
      // Empty string sentinel = lookup completed but no label → strip.
      this.refCache.set(ref, typeof label === 'string' ? label : '');
    }
  }

  private resetStream(): void {
    this.streamCursor = 0;
    this.streamPrefix = '';
    this.streamQueue.length = 0;
    // Abort any in-flight playback / pump.
    this.jobId++;
    try { this.currentAudio?.pause(); } catch { /* noop */ }
    this.cleanup();
    this.pumping = false;
    this.state.set('idle');
    this.cdr.markForCheck();
  }

  /**
   * Soft reset used when a NEW assistant message arrives mid-playback.
   *
   * Differences vs. {@link resetStream}:
   *  - Does NOT pause `currentAudio` — the chunk that's already playing for
   *    the previous message is allowed to finish naturally so we don't cut
   *    it off mid-word.
   *  - Bumps `jobId` so the pump's `while (jobId === myJob)` check trips on
   *    the next iteration, exiting cleanly after the current chunk's
   *    `playBlob` resolves. The `finally` block then re-kicks the pump for
   *    any chunks of the new message that have been queued in the meantime.
   *  - Clears the forward queue so leftover chunks from the old message
   *    don't play after the new message has started.
   */
  private softResetStream(): void {
    this.streamCursor = 0;
    this.streamPrefix = '';
    this.streamQueue.length = 0;
    // Bump jobId so the running pump exits its loop after the current
    // playBlob resolves. Do NOT pause currentAudio — let the in-flight
    // chunk play out so the previous message ends cleanly.
    this.jobId++;
  }

  /**
   * Drains the streaming queue. Synthesises one chunk ahead of playback so
   * audio transitions are smooth without flooding the TTS backend.
   *
   * Pre-fire discipline: any time the queue has an unfired head and we have
   * no `nextSynth` in flight, fire it. We check at three points per
   * iteration — before awaiting current synth, before playback, and after
   * playback — so chunks that arrive DURING synth-wait or DURING playback
   * still get their TTS started in the background instead of stalling the
   * pipeline.
   */
  private async kickPump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const myJob = ++this.jobId;
    this.state.set('loading');
    this.cdr.markForCheck();
    const fireSynth = (chunk: string) => this.api.tts({
      text: chunk,
      voice: this.effectiveVoice(),
      format: this.format(),
      speed: this.speed(),
    });
    let nextSynth: Promise<{ ok: boolean; blob?: Blob; error?: string }> | null = null;
    // Tracks the queue index whose synth is held in nextSynth. After we
    // shift() the head, the held promise corresponds to what is now
    // queue[-1] (consumed) — so we reset and re-arm against the new head.
    try {
      while (this.streamQueue.length && this.armed() && this.jobId === myJob) {
        const chunk = this.streamQueue.shift()!;
        const cur = nextSynth ?? fireSynth(chunk);
        nextSynth = null;
        // Pre-fire NEXT chunk if queue already has more (covers immediate-
        // play / multi-sentence-burst case).
        if (this.streamQueue.length > 0) nextSynth = fireSynth(this.streamQueue[0]);

        const res = await cur;
        if (this.jobId !== myJob || !this.armed()) break;
        // Pre-fire again — new chunks may have arrived during the synth wait.
        if (this.streamQueue.length > 0 && !nextSynth) {
          nextSynth = fireSynth(this.streamQueue[0]);
        }

        if (!res.ok || !res.blob) {
          const errMsg = !res.ok ? res.error : 'no blob';
          console.warn('[voice-speaker] skipped chunk due to TTS failure:', errMsg, chunk);
          continue;
        }
        await this.playBlob(res.blob, myJob);
        if (this.jobId !== myJob || !this.armed()) break;
        // Pre-fire again — chunks that arrived during PLAYBACK are by far
        // the most common case in real-time streaming. Without this, the
        // next iteration would have to wait a full TTS round-trip with no
        // audio, defeating the whole point of the one-ahead pipeline.
        if (this.streamQueue.length > 0 && !nextSynth) {
          nextSynth = fireSynth(this.streamQueue[0]);
        }
      }
    } finally {
      this.pumping = false;
      if (this.jobId === myJob) {
        this.state.set('idle');
        this.cdr.markForCheck();
      }
      // If we exited because jobId was bumped (soft reset for a new
      // message), the in-flight chunk has now finished playing. Any chunks
      // queued for the NEW message are sitting in streamQueue with no pump
      // to drive them — re-kick so they get processed.
      if (this.streamQueue.length > 0 && this.armed()) {
        void this.kickPump();
      }
    }
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  async onClick() {
    // Auto-mode: clicks ARM/DISARM the toggle instead of one-shot play.
    if (this.autoMode()) {
      if (this.armed()) {
        this.armed.set(false);
        this.stop();
        this.resetStream();
        return;
      }
      // Arm WITHOUT speaking the current text — only future updates of
      // text() should trigger TTS. Seed the stream cursor at the END of
      // the current text so the existing content is treated as
      // already-heard.
      const cur = this.text() || '';
      this.streamCursor = cur.length;
      this.streamPrefix = cur.substring(0, Math.min(64, cur.length));
      this.streamQueue.length = 0;
      this.lastAutoSpoken = cur.trim();
      this.armed.set(true);
      return;
    }
    await this.playNow();
  }

  /**
   * Plays the current text. Splits long text into smaller chunks (paragraphs
   * → sentences) so the first audio starts as quickly as possible, and runs
   * a one-ahead pipeline (synthesise chunk N+1 while chunk N is playing) to
   * minimise gaps and keep backend load bounded.
   */
  private async playNow(): Promise<void> {
    if (this.state() === 'playing' || this.state() === 'loading') {
      this.stop();
      // fall through to start a fresh job
    }
    const rawText = (this.text() || '').trim();
    if (!rawText) {
      this.lastError.set('No text to speak');
      return;
    }
    this.lastAutoSpoken = rawText;
    this.lastError.set(null);
    // Resolve chip refs → friendly labels BEFORE sanitising so the listener
    // hears the record's name (e.g. "voice" repo) instead of the raw id.
    await this.ensureRefsResolved(rawText);
    // Sanitise BEFORE chunking so we don't waste a chunk slot on noise.
    const text = sanitizeForTts(rawText, this.refCache).trim();
    if (!text) return;
    const chunks = this.chunkText(text);
    if (chunks.length === 0) return;

    const myJob = ++this.jobId;
    this.state.set('loading');
    this.cdr.markForCheck();

    // One-ahead synth pipeline. We fire synth for chunk i while chunk i-1
    // is still playing — keeps audio gap small without flooding backend.
    const pending: Array<Promise<{ ok: boolean; blob?: Blob; error?: string }>> = [];
    const synth = (chunkText: string) =>
      this.api.tts({
        text: chunkText,
        voice: this.effectiveVoice(),
        format: this.format(),
        speed: this.speed(),
      });

    // Kick off synth for chunk 0 immediately, chunk 1 right behind it.
    pending.push(synth(chunks[0]));
    if (chunks.length > 1) pending.push(synth(chunks[1]));

    try {
      let skipped = 0;
      for (let i = 0; i < chunks.length; i++) {
        if (this.jobId !== myJob) return; // aborted
        const res = await pending[i];
        if (this.jobId !== myJob) return;
        // Pre-fetch the chunk after next so the pipeline stays one-ahead —
        // do this BEFORE handling a failure so subsequent chunks keep flowing.
        const nextNext = i + 2;
        if (nextNext < chunks.length && pending.length <= nextNext) {
          pending.push(synth(chunks[nextNext]));
        }
        if (!res.ok || !res.blob) {
          // Skip just this chunk and continue with the next — the TTS engine
          // occasionally fails on edge cases (e.g. very short or
          // unusual-character chunks) and aborting the whole queue is worse
          // UX than missing a sentence.
          skipped++;
          console.warn('[voice-speaker] skipped chunk due to TTS failure:', res.error, chunks[i]);
          continue;
        }
        await this.playBlob(res.blob, myJob);
        if (this.jobId !== myJob) return;
      }
      if (skipped > 0) {
        this.lastError.set(`Skipped ${skipped} section${skipped > 1 ? 's' : ''} (TTS failed)`);
      }
      this.state.set('idle');
      this.cdr.markForCheck();
    } catch (err) {
      if (this.jobId !== myJob) return;
      this.lastError.set(err instanceof Error ? err.message : String(err));
      this.cleanup();
      this.state.set('idle');
      this.cdr.markForCheck();
    }
  }

  /**
   * Splits text into TTS-friendly chunks:
   *  1. Splits by blank lines first → paragraph-level chunks.
   *  2. Any paragraph longer than `MAX_CHARS` is further split by sentence
   *     boundaries (`. `, `! `, `? `), buffering short sentences together
   *     up to `MAX_CHARS` so we don't fire one TTS call per fragment.
   */
  private chunkText(text: string): string[] {
    const MAX_CHARS = 280;
    // Drop chunks that don't actually contain any speakable letters. TTS
    // engines tend to throw or emit garbage on inputs like "---", "***",
    // "•••", pure punctuation, or whitespace-only fragments.
    const speakable = (s: string) => /\p{L}|\p{N}/u.test(s);
    const paragraphs = text
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .filter(p => p && speakable(p));
    const out: string[] = [];
    for (const p of paragraphs) {
      if (p.length <= MAX_CHARS) {
        out.push(p);
        continue;
      }
      // Match sentence-ish runs ending in . ! ? (keep trailing whitespace),
      // OR the trailing fragment with no terminator.
      const sentences = p.match(/[^.!?\n]+[.!?]+["')\]]*\s*|[^.!?\n]+$/g) ?? [p];
      let buf = '';
      for (const s of sentences) {
        if (buf && (buf.length + s.length) > MAX_CHARS) {
          if (speakable(buf)) out.push(buf.trim());
          buf = '';
        }
        buf += s;
      }
      if (buf.trim() && speakable(buf)) out.push(buf.trim());
    }
    return out;
  }

  private playBlob(blob: Blob, myJob: number): Promise<void> {
    return new Promise<void>(resolve => {
      if (this.jobId !== myJob) { resolve(); return; }
      this.cleanup();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => { this.cleanup(); resolve(); };
      audio.onerror = () => {
        this.lastError.set('Audio playback failed');
        this.cleanup();
        resolve();
      };
      this.currentAudio = audio;
      this.currentUrl = url;
      this.state.set('playing');
      this.cdr.markForCheck();
      audio.play().catch(() => { this.cleanup(); resolve(); });
    });
  }

  stop() {
    // Bumping jobId aborts any in-flight chunk queue.
    this.jobId++;
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
