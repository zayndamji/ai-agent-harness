# Claude Code in a container: the CLI, the web UI server and a non-root user.
# Only what the harness and Claude Code need is built in. Everything else comes
# from addons.conf (see addons.example.conf).
# Builds for the machine's architecture (arm64 on Apple Silicon and the Pi 5).

# The server's packages, in a separate stage: node-pty ships no Linux
# prebuilds and compiles here, so its compilers stay out of the final image.
FROM node:24-trixie-slim AS server-deps
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/harness
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-trixie-slim

# Claude Code works in git repos and searches with ripgrep. tar is in the base
# image, and the Files tab's folder download uses it.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Pin with --build-arg CLAUDE_CODE_VERSION=2.1.296; rebuild to update.
# Installed under /usr/local, outside the home folder, so the mounted home
# folder never hides a newer CLI after a rebuild.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && npm cache clean --force

# ccusage reads the local transcripts for the Usage tab, always with
# --offline, so it never goes online. Pinned to a version whose package,
# provenance and binary were checked: check a new version the same way before
# changing it. It runs a prebuilt binary from @ccusage/ccusage-<platform>;
# neither package has install scripts, and --ignore-scripts keeps it that way.
ARG CCUSAGE_VERSION=20.0.48
RUN npm install -g --ignore-scripts ccusage@${CCUSAGE_VERSION} \
    && npm cache clean --force

COPY --from=server-deps /opt/harness/node_modules /opt/harness/node_modules

# Add-ons from addons.conf, if there is one. The example is copied too so the
# COPY always has a file to match; only addons.conf is installed. This layer
# sits before the server's code, so editing the server doesn't reinstall them.
COPY install-addons.sh addons.example.conf addons.con[f] /tmp/addons/
RUN sh /tmp/addons/install-addons.sh /tmp/addons/addons.conf && rm -rf /tmp/addons

WORKDIR /opt/harness
COPY server/ ./

# Updates come from rebuilding the image, not from the running container.
# Tools you install yourself in the container (npm install -g, pip install
# --user, binaries in ~/.local/bin) go in the home folder, so they're kept.
ENV DISABLE_AUTOUPDATER=1 \
    EDITOR=vi \
    SHELL=/bin/bash \
    NPM_CONFIG_PREFIX=/home/node/.local \
    PATH=/home/node/.local/bin:$PATH

RUN mkdir -p /workspace && chown node:node /workspace

USER node
WORKDIR /workspace
EXPOSE 8080

CMD ["claude"]
