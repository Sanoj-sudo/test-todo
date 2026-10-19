#!/usr/bin/env bash
# One-shot provisioning for Amazon Linux 2023 or Ubuntu 22.04/24.04 EC2 instances.
# Usage (from the project directory on the instance):
#   sudo bash deploy/setup-ec2.sh
# Re-run it any time to deploy new code.
set -euo pipefail

APP_DIR=/opt/todoapp
APP_USER=todoapp
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo: sudo bash deploy/setup-ec2.sh" >&2
  exit 1
fi

echo "==> Installing system packages"
need_node=true
if command -v node >/dev/null && [[ $(node -p 'process.versions.node.split(".")[0]') -ge 20 ]]; then
  need_node=false
fi

if command -v dnf >/dev/null; then
  $need_node && { curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -; dnf install -y nodejs; }
  dnf install -y nginx rsync
elif command -v apt-get >/dev/null; then
  apt-get update -y
  $need_node && { curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; apt-get install -y nodejs; }
  apt-get install -y nginx rsync curl
  rm -f /etc/nginx/sites-enabled/default
else
  echo "Unsupported distro (need dnf or apt-get)" >&2
  exit 1
fi
echo "    node $(node -v)"

echo "==> Creating service user"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"

echo "==> Copying app to $APP_DIR"
mkdir -p "$APP_DIR"
if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  rsync -a --delete \
    --exclude node_modules --exclude .git --exclude .env --exclude 'certs/*.pem' \
    "$SRC_DIR/" "$APP_DIR/"
fi

cd "$APP_DIR"
echo "==> Installing npm dependencies"
npm ci --omit=dev --no-audit --no-fund

echo "==> Downloading the AWS RDS CA bundle"
mkdir -p certs
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o certs/global-bundle.pem

if [[ ! -f .env ]]; then
  cp .env.example .env
  chown root:"$APP_USER" .env
  chmod 640 .env
  echo
  echo "!!  Created $APP_DIR/.env from the example."
  echo "!!  Edit it with your RDS endpoint and credentials, then re-run this script:"
  echo "!!    sudo nano $APP_DIR/.env && sudo bash $APP_DIR/deploy/setup-ec2.sh"
  exit 0
fi

chown -R root:"$APP_USER" "$APP_DIR"
chmod 640 .env

echo "==> Installing systemd service"
cp deploy/todoapp.service /etc/systemd/system/todoapp.service
systemctl daemon-reload
systemctl enable todoapp
systemctl restart todoapp

echo "==> Configuring nginx"
cp deploy/nginx.conf /etc/nginx/conf.d/todoapp.conf
# Allow nginx to proxy to Node when SELinux is enforcing (RHEL-family)
command -v setsebool >/dev/null && setsebool -P httpd_can_network_connect 1 || true
nginx -t
systemctl enable nginx
systemctl restart nginx

echo "==> Waiting for the app to come up"
for _ in {1..15}; do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "    Healthy: $(curl -s http://127.0.0.1:3000/api/health)"
    TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)
    IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || true)
    echo
    echo "Done! Open http://${IP:-<your-ec2-public-ip>}/"
    exit 0
  fi
  sleep 2
done

echo "App did not become healthy. Check logs with: sudo journalctl -u todoapp -n 50 --no-pager" >&2
exit 1
