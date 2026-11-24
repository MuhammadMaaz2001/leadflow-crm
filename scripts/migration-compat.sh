#!/usr/bin/env bash
# Upgrade test: builds a database at the ORIGINAL schema (first 3 migrations), fills it with seed data, applies every later
# migration, then proves nothing was lost and the security posture is intact.   Usage: scripts/migration-compat.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
ADMIN="${DATABASE_URL%/*}/postgres"; URL="${DATABASE_URL%/*}/leadflow_upgrade"
psql "$ADMIN" -qc "DROP DATABASE IF EXISTS leadflow_upgrade WITH (FORCE)" 2>/dev/null; psql "$ADMIN" -qc "CREATE DATABASE leadflow_upgrade"
OLD=$(mktemp -d); cp -r packages/database/prisma "$OLD/prisma"
ls "$OLD/prisma/migrations" | grep -E '^2026' | sort | tail -n +4 | while read -r m; do rm -rf "$OLD/prisma/migrations/$m"; done
echo "old schema has migrations: $(ls "$OLD/prisma/migrations" | grep -E '^2026' | tr '\n' ' ')"
(cd packages/database && DATABASE_URL="$URL" npx prisma migrate deploy --schema "$OLD/prisma/schema.prisma" >/dev/null && DATABASE_URL="$URL" npx tsx scripts/set-role-passwords.ts >/dev/null)
# populate with realistic data through the old schema's tables (SQL, so the current Prisma client's newer columns are not required)
psql "$URL" -q <<'SQL'
INSERT INTO users (id, email, name, password_hash, email_verified_at, is_active, created_at, updated_at) VALUES (gen_random_uuid(), 'upgrade@example.com', 'Upgrade', 'x', now(), true, now(), now());
INSERT INTO outbound_emails (id, to_email, subject, body, link) VALUES (gen_random_uuid(), 'upgrade@example.com', 'old mail', 'body', 'https://x/verify?token=abc');
SQL
BEFORE=$(psql "$URL" -Atc "select (select count(*) from users), (select count(*) from outbound_emails), (select count(*) from subscription_plans)")
echo "rows before upgrade (users|outbound_emails|plans): $BEFORE"
(cd packages/database && DATABASE_URL="$URL" npx prisma migrate deploy 2>&1 | grep -E "applied|migration" | tail -3)
AFTER=$(psql "$URL" -Atc "select (select count(*) from users), (select count(*) from outbound_emails), (select count(*) from subscription_plans)")
echo "rows after upgrade:                                   $AFTER"
[ "$BEFORE" = "$AFTER" ] || { echo "ROW COUNTS CHANGED"; exit 1; }
echo "old outbound email after upgrade: $(psql "$URL" -Atc "select status, provider, sent_at is not null from outbound_emails")"
DATABASE_URL="$URL" npm run db:verify 2>&1 | tail -3
rm -rf "$OLD"
psql "$ADMIN" -qc "DROP DATABASE leadflow_upgrade WITH (FORCE)"
echo "UPGRADE TEST PASSED"
