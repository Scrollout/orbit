# The CI toolbox: every tool of `make vet`, `make quality` and `make security`, pinned, so a laptop and GitHub
# Actions run the same checks. Built by `make toolbox` from this directory only (the plugin tree is never in the
# build context). Bump a tool: ci/README.md.
# Base images are pinned by version and digest. Tool binaries are downloaded from the project's GitHub release and
# checked against the release's published sha256 before use. Debian packages (git, ca-certificates) are the
# distribution's current ones at build time; they are not pinned.
FROM koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d AS shellcheck

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS tools
ARG TARGETARCH
ARG GITLEAKS_VERSION=8.30.1
ARG ACTIONLINT_VERSION=1.7.12
ARG HADOLINT_VERSION=2.14.0
# sha256 per architecture, from each release's published checksum file. The arm64 sums were read from the releases
# but the arm64 image was not built or run in the sandbox that wrote this (amd64 only); an other architecture fails the build.
ARG GITLEAKS_SHA256_AMD64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ARG GITLEAKS_SHA256_ARM64=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
ARG ACTIONLINT_SHA256_AMD64=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
ARG ACTIONLINT_SHA256_ARM64=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6
ARG HADOLINT_SHA256_AMD64=6bf226944684f56c84dd014e8b979d27425c0148f61b3bd99bcc6f39e9dc5a47
ARG HADOLINT_SHA256_ARM64=331f1d3511b84a4f1e3d18d52fec284723e4019552f4f47b19322a53ce9a40ed
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
WORKDIR /tmp
# hadolint DL3008: the Debian packages are deliberately unpinned (see the header).
# hadolint ignore=DL3008
RUN case "${TARGETARCH}" in \
      amd64) gl_arch=x64;   al_arch=amd64; hl_arch=x86_64; gl_sha=${GITLEAKS_SHA256_AMD64}; al_sha=${ACTIONLINT_SHA256_AMD64}; hl_sha=${HADOLINT_SHA256_AMD64} ;; \
      arm64) gl_arch=arm64; al_arch=arm64; hl_arch=arm64;  gl_sha=${GITLEAKS_SHA256_ARM64}; al_sha=${ACTIONLINT_SHA256_ARM64}; hl_sha=${HADOLINT_SHA256_ARM64} ;; \
      *) echo "unsupported architecture '${TARGETARCH}': only amd64 and arm64 have pinned checksums (ci/README.md)" >&2; exit 1 ;; \
    esac \
 && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /out \
 && curl -fsSL -o gitleaks.tgz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${gl_arch}.tar.gz" \
 && echo "${gl_sha}  gitleaks.tgz" | sha256sum -c - \
 && tar -xzf gitleaks.tgz -C /out gitleaks \
 && curl -fsSL -o actionlint.tgz "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_${al_arch}.tar.gz" \
 && echo "${al_sha}  actionlint.tgz" | sha256sum -c - \
 && tar -xzf actionlint.tgz -C /out actionlint \
 && curl -fsSL -o /out/hadolint "https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-linux-${hl_arch}" \
 && echo "${hl_sha}  /out/hadolint" | sha256sum -c - \
 && chmod 0755 /out/hadolint

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=shellcheck /bin/shellcheck /usr/local/bin/shellcheck
COPY --from=tools /out/ /usr/local/bin/
# eslint and its plugin, from the lockfile (integrity hashes), outside the repo: the repo mount is read-only.
WORKDIR /opt/ci
# Claude Code for `claude plugin validate` (make plugin-validate) is pinned by the same lockfile; its install script is
# not run (--ignore-scripts): the platform package's binary is linked instead.
COPY package.json package-lock.json eslint.config.mjs eslint.security.mjs eslint-format.mjs ./
ARG TARGETARCH
RUN case "${TARGETARCH}" in amd64) cc_arch=x64 ;; arm64) cc_arch=arm64 ;; *) echo "unsupported architecture '${TARGETARCH}'" >&2; exit 1 ;; esac \
 && npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force \
 && ln -s "/opt/ci/node_modules/@anthropic-ai/claude-code-linux-${cc_arch}/claude" /usr/local/bin/claude \
 && claude --version
# Marker that in-toolbox.sh trusts (an env var set on the host could not be told from it).
RUN touch /etc/orbit-ci-toolbox
# Versions the report records (ci/scripts/lib.sh).
ENV HOME=/tmp \
    SHELLCHECK_VERSION=0.11.0 GITLEAKS_VERSION=8.30.1 ACTIONLINT_VERSION=1.7.12 HADOLINT_VERSION=2.14.0 \
    ESLINT_VERSION=9.39.5 ESLINT_PLUGIN_SECURITY_VERSION=4.0.1 CLAUDE_CODE_VERSION=2.1.288
# A fixed non-root user; make runs the container with the caller's uid instead (ci/scripts/in-toolbox.sh).
RUN useradd --system --uid 10001 --no-create-home ci
USER 10001
