#!/bin/sh
set -eu

echo "[yiran] waiting for postgres ${POSTGRES_HOST:-postgres}:${POSTGRES_PORT:-5432}..."
i=0
while [ "$i" -lt 60 ]; do
  if python - <<'PY' >/dev/null 2>&1
import os, sys
import psycopg2
host = os.environ.get("POSTGRES_HOST", "postgres")
port = int(os.environ.get("POSTGRES_PORT", "5432"))
user = os.environ.get("POSTGRES_USER", "postgres")
password = os.environ.get("POSTGRES_PASSWORD", "")
dbname = os.environ.get("POSTGRES_DB", "postgres")
try:
    conn = psycopg2.connect(
        host=host, port=port, user=user, password=password, dbname=dbname,
        connect_timeout=3,
    )
    conn.close()
    sys.exit(0)
except Exception:
    try:
        conn = psycopg2.connect(
            host=host, port=port, user=user, password=password, dbname="postgres",
            connect_timeout=3,
        )
        conn.close()
        sys.exit(0)
    except Exception:
        sys.exit(1)
PY
  then
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$i" -ge 60 ]; then
  echo "[yiran] postgres is not ready at ${POSTGRES_HOST:-postgres}" >&2
  exit 1
fi

skip_createdb=$(printf '%s' "${YIRAN_SKIP_CREATEDB:-0}" | tr '[:upper:]' '[:lower:]')
if [ "$skip_createdb" = "1" ] || [ "$skip_createdb" = "true" ] || [ "$skip_createdb" = "yes" ]; then
  echo "[yiran] skip createdb (using existing Liangce database from .env)"
else
  echo "[yiran] ensuring database ${POSTGRES_DB:-yiran} exists..."
  python - <<'PY'
import os
import psycopg2
from psycopg2 import sql
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

host = os.environ.get("POSTGRES_HOST", "postgres")
port = int(os.environ.get("POSTGRES_PORT", "5432"))
user = os.environ.get("POSTGRES_USER", "postgres")
password = os.environ.get("POSTGRES_PASSWORD", "")
dbname = os.environ.get("POSTGRES_DB", "yiran")

conn = psycopg2.connect(
    host=host, port=port, user=user, password=password, dbname="postgres",
    connect_timeout=5,
)
conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
cur = conn.cursor()
cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (dbname,))
if not cur.fetchone():
    cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(dbname)))
    print("[yiran] created database", dbname)
else:
    print("[yiran] database already exists", dbname)
cur.close()
conn.close()
PY
fi

echo "[yiran] running migrate..."
if ! python manage.py migrate --noinput; then
  echo "[yiran] migrate failed (continuing so mind-map gateway can still run)" >&2
fi

echo "[yiran] starting daphne on 0.0.0.0:8000"
exec daphne -b 0.0.0.0 -p 8000 config.asgi:application
