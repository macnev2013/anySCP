# syntax=docker/dockerfile:1.6
# E2E test runner: builds the anySCP debug binary inside the container and drives
# it with tauri-driver + WebKitWebDriver under xvfb.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/root/.cargo/bin:/root/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin \
    PNPM_HOME=/root/.local/share/pnpm \
    RUSTUP_HOME=/root/.rustup \
    CARGO_HOME=/root/.cargo \
    XDG_DATA_HOME=/root/.local/share

# ── System deps ────────────────────────────────────────────────────────────────
# Two groups:
#   1. Tauri build deps (webkit2gtk-4.1, gtk3, soup3, etc.)
#   2. WebDriver runtime deps (webkit2gtk-driver, xvfb, dbus-x11)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git make pkg-config build-essential \
        libssl-dev \
        libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \
        libsoup-3.0-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
        webkit2gtk-driver \
        xvfb x11vnc ffmpeg \
        libnss3 libatk1.0-0 libatk-bridge2.0-0 libgbm1 \
        keyutils \
        openssh-client \
        fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Sanity check: WebKitWebDriver must be on PATH (provided by webkit2gtk-driver).
# Note: the binary has no --version flag and exits non-zero from --help, so we
# only verify presence.
RUN command -v WebKitWebDriver

# ── Rust toolchain ─────────────────────────────────────────────────────────────
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --profile minimal \
 && rustc --version

# tauri-driver (the WebDriver intermediary that spawns WebKitWebDriver).
RUN cargo install tauri-driver --locked

# ── Node + pnpm ────────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@latest --activate \
 && pnpm --version

WORKDIR /workspace

# Pre-create a writable XDG dir for the Tauri app (anyscp.db lives under here).
RUN mkdir -p "$XDG_DATA_HOME"

# Install the WDIO harness deps into /opt/e2e at build time. We can't install
# at runtime because npm walks up from /workspace/tests/e2e/ and finds the
# pnpm-shaped /workspace/node_modules from the bind mount, then crashes with
# "Cannot read properties of null (reading 'matches')". /opt/e2e is outside
# the workspace so npm has no parent node_modules to confuse itself with.
COPY package.json /opt/e2e/package.json
RUN cd /opt/e2e && npm install --no-audit --no-fund --omit=optional

# sharp powers the `make screenshots` framing step. Installed separately
# (without --omit=optional) so its prebuilt platform binary — shipped as an
# optionalDependency — is included. One self-contained module; no apt deps.
RUN cd /opt/e2e && npm install --no-audit --no-fund sharp

COPY entrypoint.sh /usr/local/bin/e2e-entrypoint
RUN chmod +x /usr/local/bin/e2e-entrypoint

ENTRYPOINT ["/usr/local/bin/e2e-entrypoint"]
