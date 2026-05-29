# TheItemApp_voice

Voice (TTS + STT + voice cloning) app for TheItemApp — backed by
[OmniVoice-Studio](https://github.com/debpalash/omnivoice-studio), unified
behind a Fastify proxy that registers with the platform's core API.

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
| `voice-api`      | Fastify proxy on port 3005. Exposes `/api/tts`, `/api/stt`, `/api/voices`, etc.     |
| `omnivoice`      | OmniVoice-Studio container (thin local layer over upstream) on port 3900.           |
| `omnivoice-config` | One-shot sidecar that reconciles the `demo0001` voice profile (see below).        |

The remote and the proxy are served to the browser under `/mf/voice/*` and
`/voice-api/*` respectively, behind core's auth. The OmniVoice UI on :3900 is
treated as a playground — production traffic goes through `voice-api`.

## Frontend prefabs

The Angular remote (`platform/src/app/prefabs/`) exposes five federated
prefabs:

| Prefab            | Display type | What it does                                                                                  |
| ----------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `voiceStudio`     | standalone   | Type-to-speak playground: pick a voice + speed, synthesise, and run quick transcriptions.     |
| `voiceDictaphone` | standalone   | Record audio in the browser (or drag-drop audio/video files), transcribe, and save as a note. |
| `voiceMicButton`  | component    | Push-to-talk button. Hold to record, release to transcribe; emits a `transcribed` event.      |
| `voiceSpeaker`    | component    | Read-aloud control. Sanitises markdown/chip-refs out of text, then streams TTS playback.      |
| `voiceSettings`   | standalone   | Browse the voice catalog, preview a sample, and pick a default voice + speed + auto-mode.      |

User preferences (selected voice, speed, auto-speak) persist to
`user_ui_configs.voice` so they follow the user across apps. The mic button and
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
| `POST /api/tts`                | Text → speech. Returns the encoded audio (mp3 by default).                                |
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
docker compose up -d --build
```

Brings up the full stack on the shared `theitemapp` Docker network.

Run on a CPU-only host by overriding `OMNIVOICE_IMAGE` with the upstream CPU
tag (when available) and removing the `deploy.resources.reservations.devices`
stanza from the `omnivoice` service.
