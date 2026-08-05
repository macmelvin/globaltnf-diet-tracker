#!/bin/bash
# rebrand.sh — search-and-replace helper for white-labeling a new copy
# of the tracker app. See REBRAND-RUNBOOK.md for the full process this
# script fits into.
#
# Usage:
#   ./rebrand.sh \
#     --old-name "Diet Tracker" \
#     --new-name "NewClient Tracker" \
#     --old-domain "global-tnf-diet-tracker" \
#     --new-domain "newclient-tracker" \
#     --old-email "macmelvin.tan@gmail.com" \
#     --new-email "admin@newclient.com" \
#     [--dry-run]
#
# Run from the repo root (where portals/ and functions/ live).

set -euo pipefail

DRY_RUN=false
OLD_NAME=""
NEW_NAME=""
OLD_DOMAIN=""
NEW_DOMAIN=""
OLD_EMAIL=""
NEW_EMAIL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --old-name) OLD_NAME="$2"; shift 2 ;;
    --new-name) NEW_NAME="$2"; shift 2 ;;
    --old-domain) OLD_DOMAIN="$2"; shift 2 ;;
    --new-domain) NEW_DOMAIN="$2"; shift 2 ;;
    --old-email) OLD_EMAIL="$2"; shift 2 ;;
    --new-email) NEW_EMAIL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [[ -z "$OLD_NAME" || -z "$NEW_NAME" || -z "$OLD_DOMAIN" || -z "$NEW_DOMAIN" ]]; then
  echo "Error: --old-name, --new-name, --old-domain, --new-domain are required."
  echo "See the top of this script for usage."
  exit 1
fi

if [[ ! -d "./portals" ]]; then
  echo "Error: ./portals not found. Run this from the repo root."
  exit 1
fi

echo "== Rebrand plan =="
echo "  Name:   '$OLD_NAME'  ->  '$NEW_NAME'"
echo "  Domain: '$OLD_DOMAIN'  ->  '$NEW_DOMAIN'"
if [[ -n "$OLD_EMAIL" && -n "$NEW_EMAIL" ]]; then
  echo "  Email:  '$OLD_EMAIL'  ->  '$NEW_EMAIL'"
fi
echo "  Dry run: $DRY_RUN"
echo ""

TARGET_FILES=$(find ./portals -name "*.html" 2>/dev/null; find ./functions -name "*.js" 2>/dev/null)

if [[ -z "$TARGET_FILES" ]]; then
  echo "No target files found under ./portals or ./functions."
  exit 1
fi

COUNT_NAME=0
COUNT_DOMAIN=0
COUNT_EMAIL=0

for f in $TARGET_FILES; do
  n=$(grep -c -- "$OLD_NAME" "$f" 2>/dev/null || true)
  d=$(grep -c -- "$OLD_DOMAIN" "$f" 2>/dev/null || true)
  COUNT_NAME=$((COUNT_NAME + ${n:-0}))
  COUNT_DOMAIN=$((COUNT_DOMAIN + ${d:-0}))
  if [[ -n "$OLD_EMAIL" ]]; then
    e=$(grep -c -- "$OLD_EMAIL" "$f" 2>/dev/null || true)
    COUNT_EMAIL=$((COUNT_EMAIL + ${e:-0}))
  fi
done

echo "Matches found before replacement:"
echo "  '$OLD_NAME': $COUNT_NAME"
echo "  '$OLD_DOMAIN': $COUNT_DOMAIN"
if [[ -n "$OLD_EMAIL" ]]; then
  echo "  '$OLD_EMAIL': $COUNT_EMAIL  (NOTE: this only updates
