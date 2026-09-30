# The console is an npm-WORKSPACES monorepo (npm, not pnpm, so no corepack line)
# plus a Rust crate, `tui/`. The sandbox therefore needs Node and Rust and nothing
# chain-shaped: the console's tests run against no chain, so no Foundry or Solana CLI.
#
# NATIVE DEPS: the FULL `node:22-bookworm` image is built on `buildpack-deps:bookworm`,
# which bundles build-essential (gcc/g++/make, which cargo also links with) and python3,
# so `npm ci` and `cargo build` need no extra apt packages. If you ever switch this FROM
# to a `-slim` variant, add `build-essential python3` before the USER switch.
FROM node:22-bookworm

# Links the published GHCR package (ghcr.io/toon-protocol/console:sandcastle-agent,
# see the pull step in .github/workflows/agent-implement.yml) to this repo.
LABEL org.opencontainers.image.source="https://github.com/toon-protocol/console"

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Matt Pocock's skills, the same plugin used interactively. The runner starts each agent
# session with `/mattpocock-skills:implement` or `/mattpocock-skills:code-review`, so they
# must be installed here. A fresh install doesn't know the official marketplace yet, so add
# it first. This takes the plugin's latest release when the image is built; rebuild the
# image to pick up a newer one.
RUN /home/agent/.local/bin/claude plugin marketplace add anthropics/claude-plugins-official \
  && /home/agent/.local/bin/claude plugin install mattpocock-skills@claude-plugins-official

# ── Rust ────────────────────────────────────────────────────────────────────
# The `tui/` crate's gate is `cargo fmt --check`, `cargo clippy --all-targets -- -D
# warnings` and `cargo test`. Without the toolchain the implementer cannot run them
# and CI is the first thing that compiles its change.
#
# The toolchain is PINNED TO THE GATE: ci.yml's `tui` job uses
# `dtolnay/rust-toolchain@stable` with rustfmt and clippy, so this installs stable with
# the same two components. If you change one, change the other. `--profile minimal`
# skips docs and the other default extras.
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --default-toolchain stable --component clippy,rustfmt

# Add Claude and cargo to PATH
ENV PATH="/home/agent/.local/bin:/home/agent/.cargo/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
