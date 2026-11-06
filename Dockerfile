ARG NODE_IMAGE=node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446
FROM ${NODE_IMAGE}

ARG NPM_REGISTRY=https://registry.npmjs.org

# Keep Debian security updates available instead of freezing package revisions.
# hadolint ignore=DL3008
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        bash ca-certificates curl git ripgrep fd-find util-linux openssh-client passwd acl tmux; \
    rm -rf /var/lib/apt/lists/*

ENV NPM_CONFIG_REGISTRY=${NPM_REGISTRY}
ENV LANG=C.UTF-8
ENV INPUTRC=/etc/inputrc

COPY package.json .npmrc LICENSE /opt/pic/
RUN set -eu; \
    npm install --prefix /opt/pic --omit=dev --ignore-scripts --package-lock=false; \
    ln -s /opt/pic/node_modules/.bin/pi /usr/local/bin/pi
ENV HOME=/home/node

COPY config/pi-bootstrap.json /opt/pic/config/pi-bootstrap.json
COPY scripts/bootstrap-pi.mjs /opt/pic/scripts/bootstrap-pi.mjs
COPY config/tmux.conf /opt/pic/config/tmux.conf
COPY scripts/pic-session.sh /usr/local/bin/pic-session
COPY pic-entrypoint.sh /usr/local/bin/pic-entrypoint
COPY lib/workspace-access.sh /usr/local/bin/pic-workspace-init
COPY config/ssh-app-services.conf /etc/ssh/ssh_config.d/50-app-services.conf
COPY DEPLOYMENT.md SECURITY.md .env.example /opt/pic/
COPY config/nginx-apps.conf /opt/pic/config/nginx-apps.conf
COPY skills/app-deployment/ /opt/pic/skills/app-deployment/
RUN set -eu; \
    chmod 0755 /usr/local/bin/pic-entrypoint /usr/local/bin/pic-workspace-init /usr/local/bin/pic-session; \
    printf '%s\n' 'set completion-ignore-case on' >> /etc/inputrc; \
    printf '%s\n' \
      "PS1='\\[\\e[2;90m\\]────────────────────────────────\\[\\e[0m\\]\\n\\[\\e[1;36m\\]\\u@\\h:\\w\\$ \\[\\e[0m\\]'" \
      >> /home/node/.bashrc

# Only account/ownership initialization needs root; ordinary sessions drop capabilities.
# hadolint ignore=DL3002
USER root
WORKDIR /workspace
