#!/bin/bash
# ---------------------------------------------------------------------------
# Scheduled caller of POST /api/v1/worker/expire-notes (the template's example
# worker job). The route is a DRY RUN unless the body says "dryRun": false,
# so this scheduled caller sends it EXPLICITLY: a schedule that only counts
# would silently break retention. tests/unit/headless-notes.test.ts
# feeds this exact body through the route and checks it really deletes.
#
# Install on the host: copy to /opt/scripts/examplelab-expire-notes.sh,
# chmod 750, one line in /etc/cron.d/beyondles-jobs, e.g.
#   30 2 * * * root /opt/scripts/examplelab-expire-notes.sh /opt/examplelab/production
# Needs in that .env: APP_PORT and EXPIRE_NOTES_WORKER_KEY (a WORKER key of
# this Lab with write + notes:delete, created in the Lab's settings).
# Exit 1 on anything but HTTP 200; the route itself logs the job line,
# records the heartbeat and alerts.
# ---------------------------------------------------------------------------
set -euo pipefail

ENV_DIR="${1:?usage: expire-notes.sh <env dir with .env>}"
PORT="$(grep -E '^APP_PORT=' "$ENV_DIR/.env" | cut -d= -f2-)"
KEY="$(grep -E '^EXPIRE_NOTES_WORKER_KEY=' "$ENV_DIR/.env" | cut -d= -f2-)"
[ -n "$PORT" ] && [ -n "$KEY" ] || { echo "job=expire-notes-cron status=incomplete counts=none error=missing_settings"; exit 1; }

BODY='{"olderThanDays": 365, "dryRun": false}'

STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 \
  -X POST "http://127.0.0.1:${PORT}/api/v1/worker/expire-notes" \
  -H 'Content-Type: application/json' -H "x-api-key: ${KEY}" \
  --data "$BODY")"

if [ "$STATUS" != "200" ]; then
  echo "job=expire-notes-cron status=incomplete counts=none error=http_${STATUS}"
  exit 1
fi
echo "job=expire-notes-cron status=complete counts=calls=1"
