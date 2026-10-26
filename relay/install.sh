#!/usr/bin/env bash
# One-step setup on a host with a static public IP. Run again after moving to a new host.
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null || { echo "Install Docker first: https://docs.docker.com/engine/install/"; exit 1; }

if [ ! -f .env ]; then
  read -rp "Public hostname that points at this host (e.g. relay.example.com): " domain
  printf 'DOMAIN=%s\n' "$domain" > .env
fi

docker compose up -d --build

echo
echo "Waiting for the relay to start..."
for _ in $(seq 1 30); do
  docker compose exec -T relay node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && break
  sleep 1
done

echo
echo "Egress IP - whitelist this in Dhan (primary or secondary) for every account that uses this relay:"
docker compose exec -T relay node dist/cli.js egress
echo
echo "Create an invite for a phone:  docker compose exec relay node dist/cli.js invite --label \"Name\""
echo "Other commands:                docker compose exec relay node dist/cli.js"
