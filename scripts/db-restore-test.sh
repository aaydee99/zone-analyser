#!/usr/bin/env bash
# Restore test: copies the console's tables (schema `public`) from a backup source into a separate,
# empty TEST database, then checks every table has the same number of rows in both.
#
#   SOURCE_DB_URL  the database to test the backup of — read only (a Supabase backup restored to a
#                  new project, or production itself: pg_dump only reads)
#   TEST_DB_URL    an EMPTY scratch database (e.g. a new Supabase project). Its `public` tables are
#                  replaced. Never production.
#
#   SOURCE_DB_URL=postgresql://... TEST_DB_URL=postgresql://... bash scripts/db-restore-test.sh
#
# Needs pg_dump, pg_restore and psql (PostgreSQL 15+ client tools). Connection strings are read from
# the environment only and never printed. The dump holds ciphertext of the stored credentials (the
# vault): keep the test database private and delete it afterwards.
set -euo pipefail

: "${SOURCE_DB_URL:?Set SOURCE_DB_URL (the database to read)}"
: "${TEST_DB_URL:?Set TEST_DB_URL (an empty scratch database)}"
if [ "$SOURCE_DB_URL" = "$TEST_DB_URL" ]; then echo "SOURCE_DB_URL and TEST_DB_URL are the same database: refusing" >&2; exit 1; fi
for tool in pg_dump pg_restore psql; do command -v "$tool" >/dev/null || { echo "$tool is not installed" >&2; exit 1; }; done

DUMP="$(mktemp -d)/console.dump"
trap 'rm -rf "$(dirname "$DUMP")"' EXIT

echo "1/3 Dumping schema public from the source (read only)…"
pg_dump --dbname="$SOURCE_DB_URL" --schema=public --format=custom --no-owner --no-privileges --file="$DUMP"

echo "2/3 Restoring into the test database…"
# profiles.id references auth.users, which is not copied (Supabase Auth owns it): in a new project
# those profile rows fail to restore and show as DIFF below. That is expected unless you also
# restored the Auth users (a full-project backup restore does). Errors are shown, never hidden.
pg_restore --dbname="$TEST_DB_URL" --clean --if-exists --no-owner --no-privileges "$DUMP" || echo "   (pg_restore reported errors above: check them — profile rows need their auth.users rows)"

echo "3/3 Comparing row counts…"
count() { psql "$1" -At -c "select count(*) from public.\"$2\"" 2>/dev/null || echo "missing"; }
TABLES=$(psql "$SOURCE_DB_URL" -At -c "select tablename from pg_tables where schemaname = 'public' order by 1")
failed=0
for t in $TABLES; do
  a=$(count "$SOURCE_DB_URL" "$t"); b=$(count "$TEST_DB_URL" "$t")
  if [ "$a" = "$b" ]; then printf '  ok    %-22s %s rows\n' "$t" "$a"; else printf '  DIFF  %-22s source %s, test %s\n' "$t" "$a" "$b"; failed=1; fi
done
# A sample of real reads the console does, on the restored copy.
psql "$TEST_DB_URL" -At -c "select 'latest run: ' || coalesce(max(started_at)::text, 'none') from public.runs" || failed=1
psql "$TEST_DB_URL" -At -c "select 'vault present: ' || (count(*) = 1) from public.vault" || failed=1

if [ "$failed" = 0 ]; then echo "Restore test passed."; else echo "Restore test FAILED: see DIFF lines above." >&2; exit 1; fi
