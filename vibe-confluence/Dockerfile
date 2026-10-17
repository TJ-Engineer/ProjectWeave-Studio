FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/database/package.json packages/database/package.json
RUN npm ci --fetch-retries=5 --fetch-retry-maxtimeout=120000
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3100 \
    HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd --system --gid 10001 knowledge \
  && useradd --system --uid 10001 --gid knowledge knowledge
COPY --from=build --chown=knowledge:knowledge /app /app
USER knowledge
EXPOSE 3100
CMD ["npm", "run", "start"]
