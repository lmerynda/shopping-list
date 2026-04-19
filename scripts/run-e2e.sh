#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

cleanup() {
  docker compose down -v >/dev/null 2>&1 || true
}

trap cleanup EXIT

docker compose up -d --wait postgres >/dev/null

DATABASE_URL="postgresql://shopping:shopping@127.0.0.1:54329/shopping_list" npx playwright test "$@"
