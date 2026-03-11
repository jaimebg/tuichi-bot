#!/bin/bash
set -euo pipefail

echo "=== Tuichi Bot VPS Setup ==="
echo "This script sets up the bot on a fresh Oracle Cloud Free Tier instance."
echo ""

# Check if Node.js 22+ is installed
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 22 ]]; then
  echo "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "Node.js version: $(node -v)"

# Clone if not present
PROJECT_DIR="$HOME/tuichi-bot"
if [ ! -d "$PROJECT_DIR" ]; then
  echo "Enter your git repository URL:"
  read -r REPO_URL
  git clone "$REPO_URL" "$PROJECT_DIR"
fi

cd "$PROJECT_DIR"
npm install --production

# Create data directory
mkdir -p data

# .env setup
if [ ! -f .env ]; then
  echo ""
  echo "=== .env file not found ==="
  echo "Create .env manually with your credentials before starting the bot."
  echo "Required variables: TWITCH_USERNAME, TWITCH_CHANNEL, TWITCH_OAUTH_TOKEN,"
  echo "  TWITCH_API_TOKEN, TWITCH_REFRESH_TOKEN, TWITCH_CLIENT_ID,"
  echo "  TWITCH_CLIENT_SECRET, GROQ_API_KEY"
  echo "Optional: HEALTH_PORT=9090, HEALTH_API_KEY=your-secret-key"
fi

# Install systemd service
echo "Installing systemd service..."
sudo cp tuichi-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable tuichi-bot
echo "Service installed. Start with: sudo systemctl start tuichi-bot"

# Setup backup cron
echo "Setting up daily backup cron at 04:00..."
CRON_CMD="0 4 * * * $PROJECT_DIR/scripts/backup-db.sh $PROJECT_DIR >> /var/log/tuichi-backup.log 2>&1"
(crontab -l 2>/dev/null | grep -v 'backup-db.sh'; echo "$CRON_CMD") | crontab -
echo "Crontab updated."

echo ""
echo "=== Setup complete ==="
echo "1. Create/edit .env with your credentials"
echo "2. Start: sudo systemctl start tuichi-bot"
echo "3. Logs: journalctl -u tuichi-bot -f"
echo "4. Health: curl http://localhost:9090/health"
