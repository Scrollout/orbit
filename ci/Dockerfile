# The CI toolbox: every tool of `make vet`, `make quality` and `make security`, pinned, so a laptop and GitHub
# Actions run the same checks. Built by `make toolbox` from this directory only (the plugin tree is never in the
# build context). Bump a tool: ci/README.md.
# Base images are pinned by version and digest. Tool binaries are downloaded from the project's GitHub release and
# checked against the release's published sha256 before use. Debian packages (git, ca-certificates) are the
# distribution's current ones at build time; they are not pinned.
FROM koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d AS shellcheck

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS tools
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ARG ACTIONLINT_VERSION=1.7.12
ARG ACTIONLINT_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
ARG HADOLINT_VERSION=2.14.0
ARG HADOLINT_SHA256=6bf226944684f56c84dd014e8b979d27425c0148f61b3bd99bcc6f39e9dc5a47
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
WORKDIR /tmp
# hadolint DL3008: the Debian packages are deliberately unpinned (see the header).
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /out \
 && curl -fsSL -o gitleaks.tgz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
 && echo "${GITLEAKS_SHA256}  gitleaks.tgz" | sha256sum -c - \
 && tar -xzf gitleaks.tgz -C /out gitleaks \
 && curl -fsSL -o actionlint.tgz "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" \
 && echo "${ACTIONLINT_SHA256}  actionlint.tgz" | sha256sum -c - \
 && tar -xzf actionlint.tgz -C /out actionlint \
 && curl -fsSL -o /out/hadolint "https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-linux-x86_64" \
 && echo "${HADOLINT_SHA256}  /out/hadolint" | sha256sum -c - \
 && chmod 0755 /out/hadolint

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=shellcheck /bin/shellcheck /usr/local/bin/shellcheck
COPY --from=tools /out/ /usr/local/bin/
# eslint and its plugin, from the lockfile (integrity hashes), outside the repo: the repo mount is read-only.
WORKDIR /opt/ci
COPY package.json package-lock.json eslint.config.mjs eslint.security.mjs eslint-format.mjs ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
# Versions the report records (ci/scripts/lib.sh).
ENV CI_TOOLBOX=1 HOME=/tmp \
    SHELLCHECK_VERSION=0.11.0 GITLEAKS_VERSION=8.30.1 ACTIONLINT_VERSION=1.7.12 HADOLINT_VERSION=2.14.0 \
    ESLINT_VERSION=9.39.5 ESLINT_PLUGIN_SECURITY_VERSION=4.0.1
# A fixed non-root user; make runs the container with the caller's uid instead (ci/scripts/in-toolbox.sh).
RUN useradd --system --uid 10001 --no-create-home ci
USER 10001
