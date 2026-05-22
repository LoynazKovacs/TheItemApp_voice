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
COPY dbseed ./dbseed

USER node
EXPOSE 3005

HEALTHCHECK --interval=10s --timeout=5s --retries=10 --start-period=30s \
  CMD node -e "require('http').get('http://127.0.0.1:3005/api/health', (r) => { r.resume(); process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

CMD ["node", "dist/index.js"]
