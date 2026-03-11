#!/bin/bash
set -euo pipefail
VPS_HOST="${VPS_HOST:-tuichi-vps}"
VPS_PATH="${VPS_PATH:-/home/opc/tuichi-bot}"

echo "=== Running tests locally ==="
npm test

echo "=== Deploying to $VPS_HOST ==="
ssh "$VPS_HOST" "cd $VPS_PATH && git pull && npm install --production"

echo "=== Restarting service ==="
ssh "$VPS_HOST" "sudo systemctl restart tuichi-bot"

echo "=== Verifying health ==="
sleep 3
ssh "$VPS_HOST" "curl -sf http://localhost:9090/health && echo ' OK' || echo ' HEALTH CHECK FAILED'"

echo "=== Deploy complete ==="
