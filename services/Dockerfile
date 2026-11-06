ARG DEBIAN_IMAGE=debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4
FROM ${DEBIAN_IMAGE}

# hadolint ignore=DL3008
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
    && chmod 0755 /usr/sbin/policy-rc.d \
    && apt-get update \
    && apt-get install -y --no-install-recommends bash nginx openssh-server supervisor sudo python3 curl ca-certificates util-linux passwd \
    && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_*
ENV LANG=C.UTF-8
COPY services/ /opt/app-services/
COPY LICENSE /opt/app-services/LICENSE
RUN chmod 0755 /opt/app-services/entrypoint.sh /opt/app-services/healthcheck.sh /opt/app-services/register-key.py /opt/app-services/app-control.py \
    && ln -s /opt/app-services/app-control.py /usr/local/bin/deploy-apps \
    && ln -s /opt/app-services/register-key.py /usr/local/bin/deploy-register \
    && ln -sf /opt/app-services/supervisord.conf /etc/supervisor/supervisord.conf
# The SSH administrator has explicit container-root capability through sudo.
# hadolint ignore=DL3002
USER root
WORKDIR /srv/app-services
ENTRYPOINT ["/opt/app-services/entrypoint.sh"]
