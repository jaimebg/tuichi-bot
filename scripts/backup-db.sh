#!/bin/bash
set -euo pipefail
PROJECT_DIR="${1:-$HOME/tuichi-bot}"
BACKUP_DIR="$PROJECT_DIR/data/backups"
mkdir -p "$BACKUP_DIR"
DEST="$BACKUP_DIR/tuichi-$(date +%Y%m%d).db"
node --input-type=module -e "
import { Database } from '$PROJECT_DIR/src/persistence/database.js';
const db = new Database('$PROJECT_DIR/data/tuichi.db');
await db.raw.backup('$DEST');
db.close();
console.log('Backed up to $DEST');
"
find "$BACKUP_DIR" -name "*.db" -mtime +7 -delete
