#!/usr/bin/env bash
# Deploy to Render without opening the dashboard.
#
# Render has not auto deployed since 17 August 2026. Six commits went nowhere and
# nobody knew, because a service that fails to deploy keeps serving the old build and
# says nothing. A deploy hook takes the dashboard out of the loop: it is a URL Render
# gives the service, and a POST to it starts a build.
#
# One time setup, by William, in the Render dashboard:
#   stone-square-sign -> Settings -> Deploy Hook -> copy the URL
#   then add this line to .env, which is gitignored and never leaves the machine:
#     RENDER_DEPLOY_HOOK=<the URL>
#
# After that: ./scripts/deploy.sh
set -u
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

if [ -z "${RENDER_DEPLOY_HOOK:-}" ]; then
  echo "No RENDER_DEPLOY_HOOK in .env. See the top of this file for the one time setup."
  exit 1
fi

BEFORE=$(curl -s --max-time 45 "${APP_BASE_URL:-https://stone-square-sign.onrender.com}/app.js" \
  | shasum | cut -c1-12)
echo "live build right now: $BEFORE"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$RENDER_DEPLOY_HOOK")
if [ "$code" != "200" ] && [ "$code" != "201" ]; then
  echo "Render refused the deploy hook, HTTP $code. The hook may be stale; copy a fresh one."
  exit 1
fi
echo "build started. watching for it to go live, up to 15 minutes."

for i in $(seq 1 45); do
  sleep 20
  NOW=$(curl -s --max-time 45 "${APP_BASE_URL:-https://stone-square-sign.onrender.com}/app.js" \
    | shasum | cut -c1-12)
  if [ -n "$NOW" ] && [ "$NOW" != "$BEFORE" ]; then
    echo "LIVE after about $((i * 20)) seconds. new build: $NOW"
    exit 0
  fi
done
echo "Still the old build after 15 minutes. Check the build log in Render; it is failing there."
exit 1
