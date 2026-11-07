#!/bin/sh
# The official PostgreSQL entrypoint runs this only when PGDATA is initialized.
set -eu
if [ "$CODEHARBOR_POSTGRES_APP_USER" = "$POSTGRES_USER" ]; then
  echo 'Application and administrator roles must differ' >&2
  exit 1
fi
CODEHARBOR_POSTGRES_APP_PASSWORD=$(cat "$CODEHARBOR_POSTGRES_APP_PASSWORD_FILE")
if [ -z "$CODEHARBOR_POSTGRES_APP_PASSWORD" ]; then
  echo 'Application database password must not be empty' >&2
  exit 1
fi
export CODEHARBOR_POSTGRES_APP_PASSWORD
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
\getenv app_user CODEHARBOR_POSTGRES_APP_USER
\getenv app_db CODEHARBOR_POSTGRES_APP_DB
\getenv app_password CODEHARBOR_POSTGRES_APP_PASSWORD
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE :"app_db" OWNER :"app_user";
SQL
unset CODEHARBOR_POSTGRES_APP_PASSWORD
