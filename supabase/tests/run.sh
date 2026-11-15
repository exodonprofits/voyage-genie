#!/usr/bin/env bash
# Run the vg_ migrations and tests on a throwaway local PostgreSQL database.
# Usage: bash supabase/tests/run.sh   (needs psql and a local server you can
# reach as the postgres user; never point this at a Supabase project).
set -euo pipefail
cd "$(dirname "$0")/.."
DB=vg_schema_test
PSQL=(psql -X -v ON_ERROR_STOP=1 -q)
if [ "$(id -un)" = root ]; then PSQL=(su postgres -c "psql -X -v ON_ERROR_STOP=1 -q -d $DB"); fi
run() { if [ "$(id -un)" = root ]; then su postgres -c "psql -X -v ON_ERROR_STOP=1 -q -d $DB" < "$1"; else psql -X -v ON_ERROR_STOP=1 -q -d "$DB" -f "$1"; fi; }
admin() { if [ "$(id -un)" = root ]; then su postgres -c "psql -X -q -c \"$1\""; else psql -X -q -d postgres -c "$1"; fi; }
admin "drop database if exists $DB"
admin "create database $DB"
run tests/supabase_stub.sql
for f in migrations/*.sql; do echo "apply $f"; run "$f"; done
run tests/vg_rls_test.sql 2>&1 | grep -vE '^\s*$|^ [0-9a-f-]{36}$' | sed 's/^NOTICE:  //'
admin "drop database $DB"
