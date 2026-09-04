# The model gateway as a Railway service, built from its public source.
# Needs the same environment the gateway reads on any host: DATABASE_URL
# (the Railway Postgres reference), GATEWAY_PORT (4000), GATEWAY_ADMIN_TOKEN,
# GATEWAY_JWT_SECRET, OPENHERMIT_SECRETS_KEY, OPENROUTER_API_KEY. It runs its
# own database migrations at start. Listens on 0.0.0.0 and on :: so Railway's
# private network (IPv6) reaches it as http://<service>.railway.internal:4000.
FROM node:22-bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq git ca-certificates >/dev/null && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG OPENHERMIT_REF=main
RUN git clone --depth 1 --branch "$OPENHERMIT_REF" https://github.com/HCF-STUDIOS/openhermit.git . \
  && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund)
ENV NODE_ENV=development
ENV GATEWAY_HOST=::
EXPOSE 4000
CMD ["node", "-C", "development", "--import", "tsx", "apps/gateway/src/index.ts"]
