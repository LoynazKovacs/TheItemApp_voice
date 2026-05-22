import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Run ffprobe in JSON mode against a file path and return the parsed
 *  result. Used to enumerate streams BEFORE invoking the transcoder so we
 *  can emit precise error messages ("audio codec X not supported" vs.
 *  "no audio track at all"). */
async function ffprobeStreams(path: string): Promise<{
  streams: Array<{ codec_type?: string; codec_name?: string; duration?: string }>;
  format?: { format_name?: string; duration?: string };
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      path,
    ];
    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c) => out.push(c as Buffer));
    child.stderr.on('data', (c) => err.push(c as Buffer));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) {
        reject(new Error(`ffprobe exited ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(out).toString('utf8'));
        resolve({ streams: parsed.streams ?? [], format: parsed.format, stderr });
      } catch (e) {
        reject(new Error(`ffprobe JSON parse failed: ${(e as Error).message}`));
      }
    });
  });
}

export interface TranscodeResult {
  /** 16-bit little-endian PCM, 24 kHz, mono — what OmniVoice expects. */
  wav: Buffer;
  /** Decoded duration in seconds, parsed from the WAV header. May be null
   *  if ffmpeg produced no audible output. */
  durationS: number | null;
}

/**
 * Transcode any media file (audio or video, any container/codec) into a
 * canonical 24 kHz mono PCM WAV. Works because ffmpeg auto-detects the input
 * format and our STT pipeline (faster-whisper inside OmniVoice) consistently
 * accepts this format.
 *
 * Why we write the INPUT to a temp file instead of piping it via stdin:
 * MP4/MOV (and some MKV variants) store the metadata index (`moov` atom) at
 * the END of the file. ffmpeg needs to seek back to read it after scanning
 * the file body. stdin (`pipe:0`) is not seekable, so ffmpeg silently emits
 * an empty WAV for these containers. OGG/WAV/MP3 work fine via pipe because
 * they're linearly streamable, which is why import-by-pipe seemed to work
 * before — until we tested with a video file from a phone camera.
 *
 * We still stream OUTPUT via stdout — that side is always linear PCM and
 * doesn't need seeking.
 */
export async function transcodeToWav(input: Buffer): Promise<TranscodeResult> {
  // Pick a unique tmp filename so concurrent imports don't collide.
  const tmpInputPath = join(
    tmpdir(),
    `voice-import-${Date.now()}-${randomBytes(6).toString('hex')}`,
  );
  await fs.writeFile(tmpInputPath, input);

  try {
    // Pre-flight: ffprobe the input so we can tell the user EXACTLY what's
    // wrong if the transcode produces nothing (no audio stream at all vs.
    // unsupported codec vs. malformed container). Doing this BEFORE ffmpeg
    // makes the error message specific instead of generic.
    let probe: Awaited<ReturnType<typeof ffprobeStreams>> | null = null;
    try {
      probe = await ffprobeStreams(tmpInputPath);
    } catch {
      // If probe itself fails the file is fundamentally unreadable.
      throw new Error('The uploaded file could not be parsed as a media container.');
    }
    const audioStreams = probe.streams.filter((s) => s.codec_type === 'audio');
    if (audioStreams.length === 0) {
      throw new Error(
        'The uploaded file has no audio track to transcribe (only video / image streams were detected).',
      );
    }

    return await new Promise<TranscodeResult>((resolve, reject) => {
      const args = [
        '-hide_banner',
        // `warning` is verbose enough to capture "no decodable audio" /
        // "codec not supported" notes, but still hides per-frame progress.
        '-loglevel', 'warning',
        // Seekable file input — required for MP4/MOV's trailing moov atom.
        '-i', tmpInputPath,
        // Drop any video stream (in case input is mp4/mkv/etc.).
        '-vn',
        // Output PCM 16-bit LE, 24 kHz, mono.
        '-ar', '24000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        // WAV container, stdout.
        '-f', 'wav',
        'pipe:1',
      ];

      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      child.stdout.on('data', (c) => outChunks.push(c as Buffer));
      child.stderr.on('data', (c) => errChunks.push(c as Buffer));
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        const stderr = Buffer.concat(errChunks).toString('utf8');
        if (code !== 0) {
          reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        const wav = Buffer.concat(outChunks);
        // Compute duration from the WAV header. We can't use fixed offsets for
        // the data subchunk size because ffmpeg may insert a `LIST` chunk
        // (metadata like title/artist copied from MP4) BETWEEN `fmt ` and
        // `data`. We must walk the RIFF chunks to find the actual `data`
        // chunk. (OGG files have no embedded metadata so ffmpeg doesn't write
        // a LIST chunk — which is why import-from-OGG worked with fixed
        // offsets while MP4 / MOV / phone-camera media did not.)
        let durationS: number | null = null;
        if (wav.length >= 44 && wav.subarray(0, 4).toString('ascii') === 'RIFF') {
          // `fmt ` subchunk is required and immediately follows the WAVE tag
          // at offset 12. Its layout is well-known so we can read fmt fields
          // at the standard offsets.
          const numChannels = wav.readUInt16LE(22);
          const sampleRate = wav.readUInt32LE(24);
          const bitsPerSample = wav.readUInt16LE(34);
          // Walk chunks starting at offset 12 (after "WAVE"). Each chunk is
          // 4-byte ASCII tag + 4-byte LE size + payload. Stop when we hit
          // `data`.
          let cursor = 12;
          let dataSize: number | null = null;
          let dataStart = 0;
          while (cursor + 8 <= wav.length) {
            const tag = wav.subarray(cursor, cursor + 4).toString('ascii');
            const size = wav.readUInt32LE(cursor + 4);
            if (tag === 'data') {
              dataSize = size;
              dataStart = cursor + 8;
              break;
            }
            // Chunk sizes are padded to an even number of bytes per the RIFF
            // spec — if the size is odd, skip the trailing pad byte.
            cursor += 8 + size + (size % 2);
          }
          // ffmpeg can't seek a pipe so it writes 0xFFFFFFFF as the data
          // size sentinel. Fall back to the actual remaining bytes of the
          // buffer in that case.
          if (dataSize !== null && (dataSize === 0xffffffff || dataStart + dataSize > wav.length)) {
            dataSize = wav.length - dataStart;
          }
          const bytesPerSample = (bitsPerSample / 8) * numChannels;
          if (dataSize !== null && dataSize > 0 && sampleRate > 0 && bytesPerSample > 0) {
            durationS = dataSize / bytesPerSample / sampleRate;
          }
        }
        // Reject if the transcode produced no audio at all even though
        // ffprobe found an audio stream — almost certainly a codec the
        // bundled ffmpeg can't decode. Surface the codec name so we can
        // act on it (e.g. install an extra codec package in the image).
        if (durationS !== null && durationS < 0.1) {
          const codecs = audioStreams.map((s) => s.codec_name ?? 'unknown').join(', ');
          reject(new Error(
            `Audio stream(s) found (codec: ${codecs}) but ffmpeg produced empty output. ` +
            `The codec may not be supported by this build. ffmpeg stderr: ${stderr.slice(0, 300) || '(none)'}`,
          ));
          return;
        }
        resolve({ wav, durationS });
      });
    });
  } finally {
    // Best-effort cleanup; if it fails the OS tmp reaper will handle it.
    fs.unlink(tmpInputPath).catch(() => { /* noop */ });
  }
}
