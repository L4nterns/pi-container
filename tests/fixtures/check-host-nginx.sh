#!/bin/sh
# Parse the actual host template with disposable TLS material; do not bind ports.
set -eu
umask 077
root=$(mktemp -d /run/host-nginx-check.XXXXXXXX)
trap 'rm -rf -- "$root"' EXIT
trap 'exit 1' HUP INT TERM
openssl req -x509 -newkey ed25519 -nodes -days 1 -subj /CN=app-demo.example.com \
    -keyout "$root/key.pem" -out "$root/cert.pem" >/dev/null 2>&1
cat > "$root/nginx.conf" <<EOF
error_log stderr warn;
pid $root/nginx.pid;
events {}
http {
    access_log off;
    ssl_certificate $root/cert.pem;
    ssl_certificate_key $root/key.pem;
    map \$http_upgrade \$connection_upgrade { default upgrade; '' ''; }
    include $1;
}
EOF
nginx -t -c "$root/nginx.conf"
