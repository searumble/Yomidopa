#!/bin/bash
# ローカルの PostgreSQL(要: postgres ユーザーで psql が使えること)で schema.sql をテストする
set -e
cd "$(dirname "$0")"
DB=yomidopa_test
su postgres -c "dropdb --if-exists $DB 2>/dev/null; createdb $DB"
su postgres -c "psql -q -v ON_ERROR_STOP=1 -d $DB -f stub.sql" >/dev/null
su postgres -c "psql -q -v ON_ERROR_STOP=1 -d $DB -f ../schema.sql" 2>/dev/null
su postgres -c "psql -q -v ON_ERROR_STOP=1 -d $DB -f ../schema.sql" 2>/dev/null   # 2回流しても壊れないこと
su postgres -c "psql -q -tA -v ON_ERROR_STOP=1 -d $DB -f test.sql" 2>&1 | grep -E "OK|NG|ERROR|ALL_OK" | sed 's/^psql:[^ ]* NOTICE:  /  /'
