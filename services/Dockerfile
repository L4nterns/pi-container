ARG NODE_IMAGE=node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446
FROM ${NODE_IMAGE}

# System packages deliberately receive Debian security updates.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx openssh-server python3 curl util-linux passwd \
    && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
    && userdel node
ENV LANG=C.UTF-8
COPY services/ /opt/app-services/
COPY LICENSE /opt/app-services/LICENSE
RUN chmod 0755 /opt/app-services/entrypoint.sh /opt/app-services/gateway.mjs /opt/app-services/admin.mjs \
    && ln -s /opt/app-services/gateway.mjs /usr/local/bin/deploy-gateway \
    && ln -s /opt/app-services/admin.mjs /usr/local/bin/deploy-admin
# Root is the supervisor; every submitted application runs as a dedicated UID.
# hadolint ignore=DL3002
USER root
WORKDIR /srv/app-services
ENTRYPOINT ["/opt/app-services/entrypoint.sh"]
