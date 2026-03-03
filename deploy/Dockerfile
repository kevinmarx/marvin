FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/marvin

# ── System packages ──────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    sqlite3 \
    git \
    curl \
    tmux \
    jq \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# ── GitHub CLI ───────────────────────────────────────────────────────────────
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*

# ── Node.js 20.x + Claude Code CLI ──────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g @anthropic-ai/claude-code

# ── uv (for local-memory-mcp Python plugin) ─────────────────────────────────
RUN curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh

# ── Create marvin user (uid 1000) ────────────────────────────────────────────
RUN useradd -m -s /bin/bash -u 1000 marvin

# ── Copy marvin repo ─────────────────────────────────────────────────────────
COPY . /home/marvin/marvin
RUN chown -R marvin:marvin /home/marvin/marvin

# ── Copy MCP plugins (bundled in image) ──────────────────────────────────────
# Plugins should be placed in deploy/plugins/ before building:
#   deploy/plugins/linear-mcp/
#   deploy/plugins/local-memory-mcp/
COPY deploy/plugins /home/marvin/plugins
RUN chown -R marvin:marvin /home/marvin/plugins

# ── Setup marvin home ───────────────────────────────────────────────────────
# Scripts use $HOME/.marvin/{state,logs,backups} — symlink all to /data/state/*
# so everything persists on the volume
RUN mkdir -p /home/marvin/.marvin && \
    ln -sf /data/state /home/marvin/.marvin/state && \
    ln -sf /data/state/logs /home/marvin/.marvin/logs && \
    ln -sf /data/state/backups /home/marvin/.marvin/backups && \
    chown -R marvin:marvin /home/marvin/.marvin

# ── Volume mount points ─────────────────────────────────────────────────────
RUN mkdir -p /data/state /data/repos && \
    chown -R marvin:marvin /data

EXPOSE 7777

USER marvin
WORKDIR /home/marvin/marvin

ENTRYPOINT ["/home/marvin/marvin/deploy/entrypoint.sh"]
