# syntax=docker/dockerfile:1
# Plim server image. Works with `podman build` and `docker build -f Containerfile`.

# ---- build ----
FROM docker.io/library/rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY server server
# Cache the registry and target dir between builds; copy the binary out of the
# cache mount within the same step.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p plim-server \
 && mkdir -p /out /data \
 && cp target/release/plim-server /out/plim-server \
 && ln -s plim-server /out/tiro-server

# ---- runtime: glibc, no shell, runs as uid 65532 ----
FROM gcr.io/distroless/cc-debian12:nonroot
# /app/tiro-server: the binary's name before the rename, for a health check or Exec that still
# says it.
COPY --from=build /out/ /app/
COPY web /app/web
COPY admin /app/admin
COPY --from=build --chown=65532:65532 /data /data

# (tiro.db: the database's file name from before the rename, kept so existing volumes open.)
ENV PLIM_ADDR=0.0.0.0:3000 \
    PLIM_DB=/data/tiro.db \
    PLIM_WEB=/app/web \
    PLIM_ADMIN_WEB=/app/admin

USER 65532:65532
EXPOSE 3000
VOLUME /data
# Kept by Docker and by `podman build --format docker` (Podman's default OCI format drops it).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["/app/plim-server", "--healthcheck"]
ENTRYPOINT ["/app/plim-server"]
