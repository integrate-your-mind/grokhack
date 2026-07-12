# Prefer alpine+apk when docker hub library/node is flaky on this host.
# Secrets: never COPY .env / tunnel creds — see .dockerignore. Mount at runtime.
FROM alpine:3.21
WORKDIR /app
RUN apk add --no-cache nodejs npm wget tini python3 make g++ \
  && node -v && npm -v
COPY package.json package-lock.json ./
# Prefer lockfile when network allows; fall back to npm install
RUN npm ci --omit=dev || npm install --omit=dev
COPY server ./server
COPY public ./public
COPY src ./src
# HTTP must be reachable by sidecar/cluster DNS; telnet stays loopback-only.
ENV BIND_HOST=0.0.0.0
ENV TELNET_BIND_HOST=127.0.0.1
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080
# Do not EXPOSE 4000 — telnet is not a public edge surface.
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=4 \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npx", "tsx", "server/index.ts"]
