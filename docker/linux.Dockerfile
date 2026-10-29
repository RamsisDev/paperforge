# Builds PaperForge's Linux installers (`make linux` from macOS or Windows). Ubuntu 22.04 like CI:
# an AppImage built on an older glibc runs on more distributions.
FROM ubuntu:22.04

ARG NODE_VERSION=22.12.0
ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/node/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential ca-certificates curl file git patchelf unzip xz-utils \
        libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libssl-dev libxdo-dev \
    && rm -rf /var/lib/apt/lists/*

RUN arch="$(dpkg --print-architecture)"; [ "$arch" = amd64 ] && arch=x64; \
    mkdir -p /usr/local/node \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
        | tar -xJ -C /usr/local/node --strip-components=1

RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
