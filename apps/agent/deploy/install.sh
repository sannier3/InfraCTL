#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "L'installation doit être exécutée en root." >&2
  exit 1
fi

ROOT=$(CDPATH= cd -- "$(dirname "$0")/../../.." && pwd)
install -d -m 0755 /opt/infra-agent /etc/infra-agent

if [ ! -f /etc/infra-agent/config.yaml ]; then
  cp "$ROOT/apps/agent/config.example.yaml" /etc/infra-agent/config.yaml
  chmod 0600 /etc/infra-agent/config.yaml
  echo "Éditez /etc/infra-agent/config.yaml avant le démarrage."
fi

pnpm --dir "$ROOT" --filter @infra/agent deploy --prod /opt/infra-agent
install -m 0644 "$ROOT/apps/agent/deploy/infra-agent.service" /etc/systemd/system/infra-agent.service
systemctl daemon-reload

echo "Service installé : infra-agent.service"
echo "Cette version s'exécute en root parce que apt-get le requiert."
echo "Aucun port entrant n'est ouvert."
echo "Démarrez avec : systemctl enable --now infra-agent"
