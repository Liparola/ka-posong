# ============================================================================
# KA-POSONG RUST CONTROL PLANE & UMANG EXTENSION ENGINE DOCKERFILE
# ============================================================================
FROM rust:1.83-slim-bookworm AS builder

WORKDIR /usr/src/rust-control-plane
RUN apt-get update && apt-get install -y pkg-config libssl-dev libsqlite3-dev && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml ./
COPY migrations ./migrations
COPY src ./src

RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates libsqlite3-0 curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=builder /usr/src/rust-control-plane/target/release/rust-control-plane /app/rust-control-plane
COPY migrations /app/migrations

RUN mkdir -p /data /app/domains /app/umail-dist
ENV DATABASE_URL=sqlite:///data/control_plane.db?mode=rwc
EXPOSE 3000

CMD ["/app/rust-control-plane"]
