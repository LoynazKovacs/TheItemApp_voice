# TheItemApp_voice

Shared TTS + STT (+ voice-cloning) service for TheItemApp. Speech synthesis is
served by two engines — [OmniVoice-Studio](https://github.com/debpalash/omnivoice-studio)
(zero-shot cloning, GPU) and [Piper](https://github.com/rhasspy/piper)
(local CPU, no cloning) — and transcription by OmniVoice's Whisper-family ASR,
all unified behind a Fastify proxy (`voice-api`) that registers with the
platform's core API.

It ships its own federated app surface (Studio / Dictaphone / Settings), but the
mic-button and speaker prefabs are designed to be **embedded by other apps** —
chat (auto-speak replies), the coding-agent terminal composer (push-to-talk +
hands-free dictation), and image-generator (prompt dictation) all consume voice
without re-implementing audio plumbing.

> The `apps` catalog row is **runtime-registered**: `voice-api` POSTs
> `/api/apps/register` on boot and is de-registered (the row removed) on graceful
> shutdown, so the Voice app only appears in core's catalog while the stack is up.

## What it does

- **Text → speech** with cloneable voices. The `voice_voices` catalog stores a
  reference recording + transcript for each voice; the backend clones it into an
  OmniVoice profile and synthesises speech in that voice.
- **Speech → text.** Record in the browser or drop in an audio/video file and
  get a transcript back.
- **Voice notes.** Recordings and imported media are saved as `voice_notes`,
  each linked to its audio file in core and stored with an editable transcript.
- **Drop-in voice for any app.** The mic button and speaker prefabs are
  federated remotes other apps embed to add push-to-talk input and read-aloud
  output without re-implementing audio plumbing.

## Stack

| Service          | Purpose                                                                             |
| ---------------- | ----------------------------------------------------------------------------------- |
| `voice`          | Angular Native Federation remote (caddy on port 80, exposed as `VOICE_WEB_PORT`).   |
| `voice-api`      | Fastify proxy on port 3005. Exposes `/api/tts`, `/api/stt`, `/api/voices`, etc. Also **hosts the Piper TTS engine in-process** (no separate container) and runs the voice-profile reconciler. |
| `omnivoice`      | OmniVoice-Studio container (thin local layer over upstream) on port 3900. GPU. Unified TTS + Whisper-family STT + zero-shot cloning. |
| `omnivoice-config` | One-shot sidecar that reconciles the `demo0001` voice profile (see below).        |

Piper is not a container — its binary + voices are baked into the `voice-api`
image (`backend/Dockerfile`) and synthesis runs in-process.

The remote and the proxy are served to the browser under `/mf/voice/*` and
`/voice-api/*` respectively, behind core's auth. The OmniVoice UI on :3900 is
treated as a playground — production traffic goes through `voice-api`.

## Engines

**TTS — two engines, picked per voice:**

- **OmniVoice** (default) — zero-shot cloning. A `voice_voices` row pairs a
  reference recording with its transcript; the reconciler clones it into an
  OmniVoice profile and `/api/tts` synthesises in that voice with a pinned
  deterministic seed. Always emits WAV via OmniVoice's native `/generate`.
- **Piper** — MIT-licensed, runs locally on CPU with no Python, no cloning. The
  binary plus five curated permissively-licensed neural voices
  (`en_US-joe-medium`, `en_US-kristin-medium`, `en_GB-cori-high`,
  `en_US-libritts_r-medium`, `en_GB-alba-medium`) are baked into the `voice-api`
  image. Voices whose `profileId` is `piper:<model>` synthesise here instead of
  going to OmniVoice. Piper also emits WAV.

**STT — OmniVoice Whisper-family ASR:** transcription goes through OmniVoice's
native `/transcribe`. WhisperX is the default backend; **faster-whisper** is the
selected capture-ASR backend, which OmniVoice additionally exposes (and can
unload) via `/sysmon/asr` + `/model/loaded` for the platform's system monitor.
All STT input is normalised through ffmpeg → 24 kHz mono WAV first (see the STT
endpoint notes below).

## Frontend prefabs

The Angular remote (`platform/src/app/prefabs/`) exposes five federated
prefabs:

| Prefab            | Display type | What it does                                                                                  |
| ----------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `voiceStudio`     | standalone   | Type-to-speak playground: pick a voice + speed, synthesise, and run quick transcriptions.     |
| `voiceDictaphone` | standalone   | Record audio in the browser (or drag-drop audio/video files), transcribe, and save as a note. |
| `voiceMicButton`  | component    | Push-to-talk **and** hands-free continuous-listening mic. Hold to record/release to transcribe, or arm it and let utterances auto-send on trailing silence; emits a `transcribed` event. |
| `voiceSpeaker`    | component    | Read-aloud control. Sanitises markdown/chip-refs out of text, then streams TTS playback.      |
| `voiceSettings`   | standalone   | Browse the voice catalog, preview a sample, and pick a default voice + speed + auto-mode + hands-free idle-send delay. |

User preferences (selected voice, speed, auto-speak, and the hands-free
`idleSendMs` trailing-silence delay) persist to `user_ui_configs.voice` so they
follow the user across apps. The mic button and
speaker are designed to be embedded inside other apps' prefabs (chat composer,
coding-agent terminal, etc.) via Native Federation.

## Data models

Two models, both scoped to the Voice app (`appId 860000000000000000000001`):

- **`voice_voices`** — catalog of cloneable TTS voices. Each row pairs a
  reference audio file (`audioFileId` → core `files`) with its verbatim
  transcript (`refText`). The reconciler clones that pair into an OmniVoice
  profile and writes the resulting id to `profileId`; the `provisionedFrom*`
  fields track what produced the current profile so drift triggers a re-clone.
- **`voice_notes`** — audio notes captured in the Dictaphone or imported from a
  media file. Each row stores `audioFileId`, the auto-generated `transcript`,
  and metadata (`language`, `durationMs`, `mimeType`).

## voice-api endpoints

All endpoints are auth-gated (core token/cookie) except the health checks:

| Method & path                  | Purpose                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `GET  /api/health`             | Liveness check for the proxy itself.                                                      |
| `GET  /api/upstreams/health`   | OmniVoice reachability (with back-compat `tts`/`stt` aliases).                             |
| `GET  /api/voices`             | List OmniVoice voices.                                                                     |
| `POST /api/tts`                | Text → speech. A `voice` of `piper:<model>` is synthesised locally by Piper (`audio/wav`); anything else is forwarded to OmniVoice. `response_format` defaults to mp3, but both engines emit WAV — the audio bytes (`audio/wav`) are returned as-is. |
| `POST /api/stt`                | Multipart audio → transcript. Transcodes to 24 kHz mono WAV via ffmpeg first.             |
| `POST /api/import-media`       | One file (audio or video) → ffmpeg → STT → upload WAV to core → create a `voice_notes` row. |
| `POST /api/voice-from-note/:noteId` | Turn a voice note into a `voice_voices` row and kick the reconciler to provision it. |

`POST /api/stt` and `/api/import-media` route input through ffmpeg before
OmniVoice because `MediaRecorder` can emit truncated webm payloads (EBML header,
no audio cluster) that libav rejects; ffmpeg salvages any decodable audio or
fails cleanly with a "no audio captured" 400.

## Voice profile reconciler

`voice-api` runs a background reconciler (`voiceProfileReconciler.ts`) that keeps
OmniVoice profiles in sync with the `voice_voices` catalog. It sweeps on startup,
every 30 s, and on demand. For each row with `audioFileId` + `refText` it:

1. Provisions a profile in OmniVoice when `profileId` is empty, missing upstream
   (e.g. after a volume reset), or has drifted from the audio/text/seed that
   produced it.
2. Pins a deterministic seed (derived from `audioFileId` + `refText`) so repeat
   TTS calls reproduce the same timbre instead of wandering.
3. Writes `profileId` + `provisionedFrom*` markers back to the row, then
   best-effort deletes the stale upstream profile on a real drift event.

Because the source-of-truth audio lives in core's `files` collection (not the
OmniVoice container volume), profiles are self-healing: a fresh OmniVoice volume
gets every profile re-cloned on the next sweep.

## OmniVoice demo voice reconciliation

The upstream `ghcr.io/debpalash/omnivoice-studio:0.2.7` image ships
`demo0001.wav` as a **440 Hz sine-wave placeholder**, not real speech. The
zero-shot voice cloner faithfully reproduces the tone, so every generated TTS
chunk comes back as noise.

We work around this in two layers:

1. A thin local image (`omnivoice-init/Dockerfile`, tag `voice-omnivoice:local`)
   bakes a real ~6s human-speech reference into `/opt/voice-init/demo0001.wav`.
2. The `omnivoice-config` sidecar runs after `omnivoice` is healthy on every
   `compose up`. It copies the wav into the named volume and patches the
   `voice_profiles.ref_text` row in `omnivoice.db` so the model knows what the
   reference audio is actually saying. Idempotent.

To swap in your own reference voice:

1. Replace `omnivoice-init/demo0001.wav` with a fresh recording (5–10 s of
   clean speech, single speaker; any format ffmpeg can read).
2. Update the `ref_text` string in `docker-compose.yml`'s `omnivoice-config`
   command to match the transcript.
3. `docker compose up -d --build omnivoice omnivoice-config`.

## Usage

```bash
npm start   # docker compose up -d --build
npm stop    # docker compose stop
```

Brings up the full stack on the shared `theitemapp` Docker network. The
`start`/`stop` scripts in `package.json` are thin wrappers over the equivalent
`docker compose` commands.

### GPU vs CPU

OmniVoice picks its inference device purely via `torch.cuda.is_available()`, so a
single env var in this stack's `.env` switches it without any image or compose
edit:

| `OMNIVOICE_CUDA_VISIBLE_DEVICES` | Effect |
| --- | --- |
| _empty_ | CPU-only — every TTS/ASR backend uses its CPU path; GPU VRAM is freed (~4 GB). Slower inference. |
| `0` | Use GPU 0 (default when the var is unset). |

Apply a change with `docker compose up -d omnivoice` (or redeploy the repo). The
GPU is left reserved by the `deploy` stanza so flipping back to GPU is just this
one variable.

On a host with **no** GPU at all, also remove the
`deploy.resources.reservations.devices` stanza from the `omnivoice` service (and
optionally override `OMNIVOICE_IMAGE` with an upstream CPU tag when available).
