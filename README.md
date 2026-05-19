# TheItemApp_voice

Voice (TTS + STT + voice cloning) app for TheItemApp — backed by
[OmniVoice-Studio](https://github.com/debpalash/omnivoice-studio), unified
behind a Fastify proxy that registers with the platform's core API.

## Stack

| Service          | Purpose                                                                             |
| ---------------- | ----------------------------------------------------------------------------------- |
| `voice`          | Angular Native Federation remote (caddy on port 80, exposed as `VOICE_WEB_PORT`).   |
| `voice-api`      | Fastify proxy on port 3005. Exposes `/api/tts`, `/api/stt`, `/api/voices`, etc.     |
| `omnivoice`      | OmniVoice-Studio container (thin local layer over upstream) on port 3900.           |
| `omnivoice-config` | One-shot sidecar that reconciles the `demo0001` voice profile (see below).        |

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
