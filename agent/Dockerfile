# OBS, hosted. One image: the desk on an interval, the daily memory backup,
# the read-only API on 4671. No key is baked in and none is read unless the
# operator mounts one at /wallet and sets OBS_TRADING=on themselves.
FROM node:22-alpine
RUN apk add --no-cache bash git ca-certificates wget
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN addgroup -S obs && adduser -S obs -G obs \
  && mkdir -p /app/data /memory /wallet \
  && chown -R obs:obs /app /memory
USER obs
ENV OBS_DATA_DIR=/app/data \
    OBS_MEMORY_REPO_DIR=/memory \
    OBS_WALLET_DIR=/wallet \
    OBS_DASHBOARD_PORT=4671 \
    OBS_DASHBOARD_ORIGINS=*
EXPOSE 4671
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:4671/api/obs/health >/dev/null || exit 1
CMD ["bash", "scripts/run.sh"]
