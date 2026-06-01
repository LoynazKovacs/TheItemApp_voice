# Thin layer on top of upstream OmniVoice-Studio that bakes in a real human-speech
# reference voice for the `demo0001` profile. The upstream image ships demo0001.wav
# as a 440 Hz sine-wave placeholder which makes all generated speech come out as
# noise (see docker-compose.yml omnivoice-config service for the runtime fix-up
# that also patches voice_profiles.ref_text to match this audio's transcript).
ARG OMNIVOICE_UPSTREAM=ghcr.io/debpalash/omnivoice-studio:0.2.7
FROM ${OMNIVOICE_UPSTREAM}

# /opt/voice-init is read by the omnivoice-config one-shot sidecar.
COPY demo0001.wav /opt/voice-init/demo0001.wav

# System-monitor patch: expose + unload the resident capture ASR (faster-whisper)
# so it can be attributed and offloaded from VRAM. Injects a router module and
# wires it into the app after the existing system router. The sed is a no-op if
# upstream renames the anchor line (patch simply isn't applied → /sysmon 404).
COPY sysmon_patch.py /app/backend/sysmon_patch.py
RUN sed -i 's/^app.include_router(system.router)$/app.include_router(system.router)\nfrom sysmon_patch import router as _sysmon_router  # system-monitor patch\napp.include_router(_sysmon_router)/' /app/backend/main.py
