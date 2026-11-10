# Claude Code in a container: the CLI, common dev tools and a non-root user.
# Builds for the machine's architecture (arm64 on Apple Silicon and the Pi 5).
FROM node:24-trixie-slim

# Pin with --build-arg CLAUDE_CODE_VERSION=2.1.296; rebuild to update.
ARG CLAUDE_CODE_VERSION=latest

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash-completion build-essential ca-certificates curl git jq less \
      openssh-client procps python3 python3-venv ripgrep unzip vim-tiny \
    && rm -rf /var/lib/apt/lists/*

# Installed under /usr/local, outside the home folder, so the home volume
# never hides a newer CLI after a rebuild.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && npm cache clean --force

# Updates come from rebuilding the image, not from the running container.
ENV DISABLE_AUTOUPDATER=1 \
    EDITOR=vi \
    SHELL=/bin/bash

RUN mkdir -p /workspace && chown node:node /workspace

USER node
WORKDIR /workspace

CMD ["claude"]
