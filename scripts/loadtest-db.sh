#!/usr/bin/env bash
# Creates (or recreates) the throw-away database used by the load tests and migrates it. Usage: scripts/loadtest-db.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
BASE="$DATABASE_URL"
ADMIN="${BASE%/*}/postgres"
LOAD="${BASE%/*}/leadflow_load"
psql "$ADMIN" -qc "DROP DATABASE IF EXISTS leadflow_load WITH (FORCE)"
psql "$ADMIN" -qc "CREATE DATABASE leadflow_load"
(cd packages/database && DATABASE_URL="$LOAD" npx prisma migrate deploy >/dev/null && DATABASE_URL="$LOAD" npx tsx scripts/set-role-passwords.ts >/dev/null)
echo "leadflow_load ready"
