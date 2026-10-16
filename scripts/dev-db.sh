#!/usr/bin/env bash
# Throwaway LOCAL PostgreSQL for tests/dev (never production). Usage: scripts/dev-db.sh start|stop|url
# Data lives in backend/.devdb (gitignored). Port 54329, trust auth, localhost only.
set -e
PGBIN="${PGBIN:-/c/Program Files/PostgreSQL/18/bin}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/.devdb"
PORT=54329
case "$1" in
  start)
    if [ ! -d "$DIR/data" ]; then
      mkdir -p "$DIR"
      "$PGBIN/initdb" -D "$DIR/data" -U postgres --auth=trust -E UTF8 >/dev/null
    fi
    "$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -c listen_addresses=127.0.0.1" -l "$DIR/pg.log" -w start >/dev/null || true
    "$PGBIN/psql" -h 127.0.0.1 -p $PORT -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='school17_test'" | grep -q 1 \
      || "$PGBIN/createdb" -h 127.0.0.1 -p $PORT -U postgres school17_test
    # A second database for the phone demo, so running the test suite never fills the demo with test data
    "$PGBIN/psql" -h 127.0.0.1 -p $PORT -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='school17_demo_test'" | grep -q 1       || "$PGBIN/createdb" -h 127.0.0.1 -p $PORT -U postgres school17_demo_test
    echo "postgresql://postgres@127.0.0.1:$PORT/school17_test?schema=public" ;;
  stop) "$PGBIN/pg_ctl" -D "$DIR/data" stop ;;
  url) echo "postgresql://postgres@127.0.0.1:$PORT/school17_test?schema=public" ;;
esac
