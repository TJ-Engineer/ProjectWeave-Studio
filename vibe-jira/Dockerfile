FROM node:24-alpine AS build

ARG APP_VERSION=development
ARG APP_REVISION=unknown

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN npm ci

COPY . .
RUN npm run build

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime

ARG APP_VERSION=development
ARG APP_REVISION=unknown

LABEL org.opencontainers.image.title="Vibe JIRA" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${APP_REVISION}" \
      org.opencontainers.image.source="https://github.com/example/vibe-jira"

RUN addgroup -S vibe && adduser -S vibe -G vibe
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    APP_VERSION=${APP_VERSION} \
    APP_REVISION=${APP_REVISION}

COPY --from=production-dependencies --chown=vibe:vibe /app /app
RUN chmod 0555 /app/infra/docker/entrypoint.sh

USER vibe
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health/ready >/dev/null || exit 1

STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/infra/docker/entrypoint.sh"]
CMD ["web"]
