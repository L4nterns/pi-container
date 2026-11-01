FROM node:24-trixie-slim

RUN set -eux; \
    sed -i -E \
    's#^URIs: https?://deb\.debian\.org/debian$#URIs: http://mirrors.tuna.tsinghua.edu.cn/debian#' \
    /etc/apt/sources.list.d/debian.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates; \
    sed -i \
    's#http://mirrors.tuna.tsinghua.edu.cn/debian#https://mirrors.tuna.tsinghua.edu.cn/debian#' \
    /etc/apt/sources.list.d/debian.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        bash curl git ripgrep fd-find util-linux; \
    rm -rf /var/lib/apt/lists/*

ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ENV LANG=C.UTF-8
ENV INPUTRC=/etc/inputrc

RUN HOME=/root npm install -g --ignore-scripts @earendil-works/pi-coding-agent
ENV HOME=/home/node

COPY docker-entrypoint.sh /usr/local/bin/pi-entrypoint
COPY skills/vibe-projects /opt/pi-docker/skills/vibe-projects
RUN chmod 0755 /usr/local/bin/pi-entrypoint /opt/pi-docker/skills/vibe-projects/scripts/publish.mjs; \
    printf '%s\n' 'set completion-ignore-case on' >> /etc/inputrc; \
    printf '%s\n' \
      "PS1='\\[\\e[2;90m\\]────────────────────────────────\\[\\e[0m\\]\\n\\[\\e[1;36m\\]\\u@\\h:\\w\\$ \\[\\e[0m\\]'" \
      >> /home/node/.bashrc

USER root
WORKDIR /workspace
