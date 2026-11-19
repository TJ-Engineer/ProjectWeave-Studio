FROM rust:1.96-bookworm AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY apps ./apps
COPY db ./db
RUN cargo build --locked --release -p openrm-api

FROM debian:bookworm-slim
ARG AWS_RDS_CA_BUNDLE_SHA256=d46e1bdfda05c8e7644e50930806a19b139a222542bf0348082fb59ece2b5fa5
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && curl --fail --silent --show-error --location \
        https://truststore.pki.rds.amazonaws.com/us-east-2/us-east-2-bundle.pem \
        --output /etc/ssl/certs/aws-rds-us-east-2-bundle.pem \
    && echo "${AWS_RDS_CA_BUNDLE_SHA256}  /etc/ssl/certs/aws-rds-us-east-2-bundle.pem" \
        | sha256sum --check --strict \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin openrm
COPY --from=builder /build/target/release/openrm-api /usr/local/bin/openrm-api
COPY --from=builder /build/target/release/migrate /usr/local/bin/openrm-migrate
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
    CMD ["curl", "--fail", "--silent", "http://127.0.0.1:8080/ready"]
ENTRYPOINT ["/usr/local/bin/openrm-api"]
