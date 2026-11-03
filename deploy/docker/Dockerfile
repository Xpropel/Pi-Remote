# Pi-Remote relay image.
#
# Contents: relay/ + the prebuilt web/ + the one production dependency
# (ws, pure JS -- no native modules, so no build toolchain is needed).
# There is no build step: web/ ships prebuilt in the repository.
# Base image tracks the engines field in package.json (node >= 22.18).
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Production dependencies first, so this layer stays cached across
# code-only rebuilds. Installed as root; the runtime never writes here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Relay code, static web UI, the docker helpers (including the
# pre-upgrade check) and the license. Tests, docs and device-side
# tooling are deliberately not part of the relay image.
COPY --chown=node:node relay/ ./relay/
COPY --chown=node:node web/ ./web/
COPY --chown=node:node deploy/docker/ ./deploy/docker/
COPY --chown=node:node LICENSE ./

# /app/data is the compose volume mount point (accounts index under
# data/accounts, room transcripts under data/rooms). /app/logs only
# needs to exist and be creatable by the runtime user.
RUN mkdir -p /app/data/rooms /app/data/accounts /app/logs \
 && chown -R node:node /app/data /app/logs /app/deploy

# Run unprivileged. The relay writes only to data/ and logs/.
USER node

# 7001 = local (extension) channel, 7002 = viewer channel + /healthz.
EXPOSE 7001 7002

CMD ["node", "relay/server.js"]
