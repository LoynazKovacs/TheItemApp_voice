# syntax=docker/dockerfile:1
#
# Voice API backend: Fastify service that proxies TTS + STT upstreams.
#

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm install
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npx tsc -p tsconfig.json

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

# ---------------------------------------------------------------------------
# Piper TTS engine + a curated set of permissively-licensed (CC0 / public
# domain / CC BY 4.0) neural voices. Piper is MIT-licensed, runs on CPU, and
# ships as a self-contained binary — no Python. Voices are synthesised locally
# (no cloning) for `voice_voices` rows whose profileId is `piper:<model>`.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS piper
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/piper
RUN curl -fsSL -o /tmp/piper.tar.gz \
      "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz" \
  && tar xzf /tmp/piper.tar.gz --strip-components=1 -C /opt/piper \
  && rm /tmp/piper.tar.gz
RUN mkdir -p /opt/piper/models \
  && cd /opt/piper/models \
  && base="https://huggingface.co/rhasspy/piper-voices/resolve/main/en" \
  && for v in \
       "en_US/joe/medium|en_US-joe-medium" \
       "en_US/kristin/medium|en_US-kristin-medium" \
       "en_GB/cori/high|en_GB-cori-high" \
       "en_US/libritts_r/medium|en_US-libritts_r-medium" \
       "en_GB/alba/medium|en_GB-alba-medium"; do \
       sub="${v%%|*}"; stem="${v##*|}"; \
       curl -fsSL -o "$stem.onnx"      "$base/$sub/$stem.onnx"; \
       curl -fsSL -o "$stem.onnx.json" "$base/$sub/$stem.onnx.json"; \
     done

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# ffmpeg is needed by /api/import-media to transcode any uploaded audio/video
# file into the canonical 24 kHz mono PCM WAV the STT pipeline expects.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=piper /opt/piper /opt/piper
COPY dbseed ./dbseed

USER node
EXPOSE 3005

HEALTHCHECK --interval=10s --timeout=5s --retries=10 --start-period=30s \
  CMD node -e "require('http').get('http://127.0.0.1:3005/api/health', (r) => { r.resume(); process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

CMD ["node", "dist/index.js"]
