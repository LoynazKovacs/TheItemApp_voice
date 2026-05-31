import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface PiperClientOptions {
  /** Directory holding the `piper` binary and its bundled shared libraries. */
  binDir: string;
  /** Directory holding the `*.onnx` voice models (+ their `.onnx.json`). */
  modelDir: string;
  /** espeak-ng data directory shipped alongside the piper binary. */
  espeakDataDir: string;
}

/**
 * Thin wrapper around the standalone Piper TTS binary.
 *
 * Piper is an MIT-licensed neural TTS that runs locally on CPU with no Python
 * runtime — the release tarball is a single binary plus a few `.so` files and
 * an espeak-ng data dir. Each voice is an `<name>.onnx` model (+ a sibling
 * `<name>.onnx.json` config). We synthesise by spawning the binary, writing the
 * text to its stdin, and reading a WAV back from its stdout (`-f -`).
 *
 * This is the synthesis path for `voice_voices` rows whose `profileId` is
 * `piper:<model>` (engine `piper`) — entirely separate from the OmniVoice
 * cloning path, so no reference recording is ever involved.
 */
export class PiperClient {
  private readonly binary: string;

  constructor(private readonly opts: PiperClientOptions) {
    this.binary = join(opts.binDir, 'piper');
  }

  /** True when the binary is present — lets routes fall back cleanly if not. */
  isAvailable(): boolean {
    return existsSync(this.binary);
  }

  /**
   * Resolve a `piper:<model>` voice token to an on-disk model path, or null if
   * the token is malformed or the model isn't installed. The model name is
   * restricted to a safe charset so the token can't escape `modelDir`.
   */
  resolveModel(voiceToken: string): string | null {
    const name = voiceToken.startsWith('piper:') ? voiceToken.slice('piper:'.length) : voiceToken;
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return null;
    const modelPath = join(this.opts.modelDir, `${name}.onnx`);
    return existsSync(modelPath) ? modelPath : null;
  }

  /**
   * Synthesise `text` with the given model file and return WAV bytes.
   *
   * `speed` matches the frontend convention (0.5–2.0, where >1 is faster).
   * Piper expresses tempo as `length_scale` (phoneme duration multiplier), the
   * inverse of speed, so we pass `1 / speed`.
   */
  async synthesize(modelPath: string, text: string, speed = 1): Promise<Buffer> {
    const clampedSpeed = Math.min(2, Math.max(0.5, Number.isFinite(speed) && speed > 0 ? speed : 1));
    const lengthScale = (1 / clampedSpeed).toFixed(3);

    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(
        this.binary,
        [
          '-m', modelPath,
          '--espeak_data', this.opts.espeakDataDir,
          '--length_scale', lengthScale,
          '-f', '-',
          '-q',
        ],
        {
          // The bundled .so files (onnxruntime, espeak-ng, piper_phonemize) sit
          // next to the binary; point the loader at them.
          env: { ...process.env, LD_LIBRARY_PATH: this.opts.binDir },
        },
      );

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(stdout));
        } else {
          reject(new Error(`piper exited with code ${code}: ${Buffer.concat(stderr).toString().slice(0, 500)}`));
        }
      });

      child.stdin.on('error', reject);
      child.stdin.write(text);
      child.stdin.end();
    });
  }
}
