# Thin layer on top of upstream OmniVoice-Studio that bakes in a real human-speech
# reference voice for the `demo0001` profile. The upstream image ships demo0001.wav
# as a 440 Hz sine-wave placeholder which makes all generated speech come out as
# noise (see docker-compose.yml omnivoice-config service for the runtime fix-up
# that also patches voice_profiles.ref_text to match this audio's transcript).
ARG OMNIVOICE_UPSTREAM=ghcr.io/debpalash/omnivoice-studio:0.2.7
FROM ${OMNIVOICE_UPSTREAM}

# /opt/voice-init is read by the omnivoice-config one-shot sidecar.
COPY demo0001.wav /opt/voice-init/demo0001.wav
