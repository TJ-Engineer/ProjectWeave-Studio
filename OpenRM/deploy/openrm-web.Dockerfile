FROM node:24-alpine AS builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY docs/user ./docs/user
COPY src ./src
ARG VITE_API_BASE_URL=/
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
ARG OPENRM_NGINX_CONFIG=deploy/web/nginx.conf
COPY ${OPENRM_NGINX_CONFIG} /etc/nginx/conf.d/default.conf
COPY deploy/web/proxy_params /etc/nginx/proxy_params
COPY --chmod=755 deploy/web/entrypoint.sh /usr/local/bin/openrm-web-entrypoint
COPY --from=builder /build/dist /usr/share/nginx/html
# Fargate creates anonymous volumes as root. Keep the root filesystem read-only
# and place nginx's transient state on the container's writable shared memory.
RUN sed -i 's#/tmp/#/dev/shm/#g' /etc/nginx/nginx.conf
EXPOSE 8080 8081
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
    CMD ["wget", "--quiet", "--spider", "http://127.0.0.1:8080/container-health"]
ENTRYPOINT ["/usr/local/bin/openrm-web-entrypoint"]
CMD ["nginx", "-g", "daemon off;"]
