ARG NODE_IMAGE=node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446
FROM ${NODE_IMAGE}

ARG NPM_REGISTRY=https://registry.npmjs.org

# Keep Debian security updates available instead of freezing package revisions.
# hadolint ignore=DL3008
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        bash ca-certificates curl git ripgrep fd-find util-linux; \
    rm -rf /var/lib/apt/lists/*

ENV NPM_CONFIG_REGISTRY=${NPM_REGISTRY}
ENV LANG=C.UTF-8
ENV INPUTRC=/etc/inputrc

COPY package.json package-lock.json LICENSE /opt/pi-docker/
RUN set -eu; \
    npm ci --prefix /opt/pi-docker --omit=dev --ignore-scripts; \
    ln -s /opt/pi-docker/node_modules/.bin/pi /usr/local/bin/pi
ENV HOME=/home/node

COPY docker-entrypoint.sh /usr/local/bin/pi-entrypoint
COPY skills/vibe-projects /opt/pi-docker/skills/vibe-projects
RUN set -eu; \
    chmod 0755 /usr/local/bin/pi-entrypoint /opt/pi-docker/skills/vibe-projects/scripts/publish.mjs; \
    printf '%s\n' 'set completion-ignore-case on' >> /etc/inputrc; \
    printf '%s\n' \
      "PS1='\\[\\e[2;90m\\]────────────────────────────────\\[\\e[0m\\]\\n\\[\\e[1;36m\\]\\u@\\h:\\w\\$ \\[\\e[0m\\]'" \
      >> /home/node/.bashrc

# Initialization and root-shell require root; ordinary Pi sessions use setpriv.
# hadolint ignore=DL3002
USER root
WORKDIR /workspace
