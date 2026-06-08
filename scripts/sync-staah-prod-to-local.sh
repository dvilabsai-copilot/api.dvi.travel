#!/usr/bin/env bash

set -euo pipefail

# Sync only STAAH-related tables from production MySQL to local MySQL.
#
# Usage:
#   cp scripts/staah-sync.env.example scripts/staah-sync.env
#   chmod +x scripts/sync-staah-prod-to-local.sh
#   ./scripts/sync-staah-prod-to-local.sh
#
# Rollback example:
#   mysql -u root -p dvi_main < backups/staah/local_staah_backup_YYYYMMDD_HHMMSS.sql

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$SCRIPT_DIR/staah-sync.env"
BACKUP_DIR="$ROOT_DIR/backups/staah"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/local_staah_backup_${TIMESTAMP}.sql"
REMOTE_DUMP_FILE="/tmp/staah_prod_dump_${TIMESTAMP}_$$.sql"
LOCAL_IMPORT_FILE="$(mktemp "${TMPDIR:-/tmp}/staah_import_${TIMESTAMP}_XXXXXX.sql")"

TABLES=(
  "staah_inbound_log"
  "staah_inventory"
  "staah_rate"
  "staah_restriction"
  "staah_reservation"
  "staah_rateplan"
  "staah_hotel_booking_confirmation"
)

cleanup() {
  rm -f "$LOCAL_IMPORT_FILE"

  if [[ -n "${PROD_SSH_USER:-}" && -n "${PROD_SSH_HOST:-}" ]]; then
    ssh -o BatchMode=yes -o LogLevel=ERROR "${PROD_SSH_USER}@${PROD_SSH_HOST}" \
      "rm -f '$REMOTE_DUMP_FILE'" >/dev/null 2>&1 || true
  fi
}

on_error() {
  local exit_code=$?
  echo "[error] Sync failed. Check the log above for the failing step." >&2
  exit "$exit_code"
}

trap cleanup EXIT
trap on_error ERR

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "[error] Missing config file: $CONFIG_FILE" >&2
  echo "Create it first with:" >&2
  echo "  cp scripts/staah-sync.env.example scripts/staah-sync.env" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$CONFIG_FILE"

required_vars=(
  "PROD_SSH_USER"
  "PROD_SSH_HOST"
  "PROD_DB_NAME"
  "PROD_DB_USER"
  "PROD_DB_PASSWORD"
  "LOCAL_DB_NAME"
  "LOCAL_DB_USER"
  "LOCAL_DB_PASSWORD"
)

for var_name in "${required_vars[@]}"; do
  if [[ -z "${!var_name:-}" ]]; then
    echo "[error] Required config variable '$var_name' is missing or empty in $CONFIG_FILE" >&2
    exit 1
  fi
done

if ! command -v ssh >/dev/null 2>&1; then
  echo "[error] 'ssh' is required but not installed." >&2
  exit 1
fi

if ! command -v mysql >/dev/null 2>&1; then
  echo "[error] 'mysql' is required but not installed or not in PATH." >&2
  exit 1
fi

if ! command -v mysqldump >/dev/null 2>&1; then
  echo "[error] 'mysqldump' is required but not installed or not in PATH." >&2
  exit 1
fi

join_by_space() {
  local joined=""
  local value
  for value in "$@"; do
    joined+="${joined:+ }$value"
  done
  printf '%s' "$joined"
}

TABLES_SQL="$(join_by_space "${TABLES[@]}")"

echo "[info] backup started"
mkdir -p "$BACKUP_DIR"

MYSQL_PWD="$LOCAL_DB_PASSWORD" mysqldump \
  --single-transaction \
  --quick \
  --skip-triggers \
  --add-drop-table \
  -u "$LOCAL_DB_USER" \
  "$LOCAL_DB_NAME" \
  "${TABLES[@]}" > "$BACKUP_FILE"

echo "[info] local backup saved: $BACKUP_FILE"
echo "[info] production dump started"

read -r -d '' REMOTE_SCRIPT <<'EOF' || true
set -euo pipefail

if ! command -v mysqldump >/dev/null 2>&1; then
  echo "[remote-error] 'mysqldump' is required on production host." >&2
  exit 1
fi

GTID_FLAG=""
if mysqldump --help 2>/dev/null | grep -q -- '--set-gtid-purged'; then
  GTID_FLAG="--set-gtid-purged=OFF"
fi

IFS=' ' read -r -a TABLE_ARRAY <<< "$TABLES_SQL"

MYSQL_PWD="$PROD_DB_PASSWORD" mysqldump \
  --single-transaction \
  --quick \
  --skip-triggers \
  --add-drop-table \
  ${GTID_FLAG:+$GTID_FLAG} \
  -u "$PROD_DB_USER" \
  "$PROD_DB_NAME" \
  "${TABLE_ARRAY[@]}" > "$REMOTE_DUMP_FILE"
EOF

REMOTE_PAYLOAD="$(
  cat <<EOF
PROD_DB_NAME=$(printf '%q' "$PROD_DB_NAME")
PROD_DB_USER=$(printf '%q' "$PROD_DB_USER")
PROD_DB_PASSWORD=$(printf '%q' "$PROD_DB_PASSWORD")
REMOTE_DUMP_FILE=$(printf '%q' "$REMOTE_DUMP_FILE")
TABLES_SQL=$(printf '%q' "$TABLES_SQL")
$REMOTE_SCRIPT
EOF
)"

ssh -T -o BatchMode=yes "${PROD_SSH_USER}@${PROD_SSH_HOST}" \
  'bash -s' <<< "$REMOTE_PAYLOAD"

ssh -T -o BatchMode=yes "${PROD_SSH_USER}@${PROD_SSH_HOST}" \
  "cat '$REMOTE_DUMP_FILE'" > "$LOCAL_IMPORT_FILE"

if [[ ! -s "$LOCAL_IMPORT_FILE" ]]; then
  echo "[error] Production dump file is empty. Import aborted." >&2
  exit 1
fi

echo "[info] local import started"
MYSQL_PWD="$LOCAL_DB_PASSWORD" mysql \
  -u "$LOCAL_DB_USER" \
  "$LOCAL_DB_NAME" < "$LOCAL_IMPORT_FILE"

echo "[info] verification summary"
for table_name in "${TABLES[@]}"; do
  row_count="$(
    MYSQL_PWD="$LOCAL_DB_PASSWORD" mysql \
      -N -B \
      -u "$LOCAL_DB_USER" \
      "$LOCAL_DB_NAME" \
      -e "SELECT COUNT(*) FROM \`$table_name\`;"
  )"
  echo "  - ${table_name}: ${row_count} rows"
done

max_received_at="$(
  MYSQL_PWD="$LOCAL_DB_PASSWORD" mysql \
    -N -B \
    -u "$LOCAL_DB_USER" \
    "$LOCAL_DB_NAME" \
    -e "SELECT MAX(received_at) FROM \`staah_inbound_log\`;"
)"

echo "  - staah_inbound_log max(received_at): ${max_received_at:-NULL}"
echo "[info] completed"
