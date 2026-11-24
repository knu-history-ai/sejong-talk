FROM node:24.22.3-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=1280
RUN npm run build -- --webpack

FROM node:24.22.3-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
CMD ["node", "server.js"]

FROM deps AS voice
ENV NODE_ENV=production REALTIME_POC_DEBUG=0
COPY --chown=node:node scripts/realtime-poc ./scripts/realtime-poc
COPY --chown=node:node src ./src
COPY --chown=node:node data ./data
USER node
CMD ["node", "--conditions=react-server", "scripts/realtime-poc/speech-engine-server.mjs"]
