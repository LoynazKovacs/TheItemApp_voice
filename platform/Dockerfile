# syntax=docker/dockerfile:1
#
# Voice remote container: builds the Angular Native Federation remote and
# serves the resulting bundle behind Caddy on port 80.
#

FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY platform/package.json platform/package-lock.json* .npmrc ./
RUN npm install --no-audit --no-fund

COPY platform/angular.json ./angular.json
COPY platform/federation.config.js ./federation.config.js
COPY platform/tsconfig*.json ./
COPY platform/src ./src
COPY platform/public ./public

RUN npm run build

FROM caddy:2.7-alpine AS runner
RUN printf ':80 {\n  root * /srv\n  file_server\n}\n' > /etc/caddy/Caddyfile
COPY --from=build /app/dist/voice-platform/browser /srv
EXPOSE 80
