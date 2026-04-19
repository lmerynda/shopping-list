#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${HOME}/.cache/ms-playwright"

echo "== Runtime =="
echo "cwd: ${ROOT_DIR}"
echo "node: $(node -v)"
echo "npm: $(npm -v)"
echo "wsl: $(uname -a)"
echo

echo "== Playwright packages =="
(cd "${ROOT_DIR}" && npm ls @playwright/test playwright --depth=0 || true)
echo

echo "== Browser cache =="
if [[ ! -d "${CACHE_DIR}" ]]; then
  echo "Playwright cache directory not found: ${CACHE_DIR}"
  exit 1
fi

find "${CACHE_DIR}" -maxdepth 3 -type f \( -name 'chrome-headless-shell' -o -name 'chrome' \) | sort
echo

BIN="$(find "${CACHE_DIR}" -maxdepth 3 -type f -name 'chrome-headless-shell' | head -n 1 || true)"
if [[ -z "${BIN}" ]]; then
  echo "No Playwright Chromium headless shell binary found."
  exit 1
fi

echo "== Selected browser binary =="
echo "${BIN}"
echo

echo "== Binary exists =="
ls -l "${BIN}"
echo

echo "== Missing shared libraries =="
MISSING="$(ldd "${BIN}" | grep 'not found' || true)"
if [[ -z "${MISSING}" ]]; then
  echo "None"
else
  echo "${MISSING}"
fi
echo

echo "== Suggested apt packages =="
if grep -q 'libnspr4.so' <<<"${MISSING:-}"; then
  echo "sudo apt install -y libnspr4"
fi
if grep -q 'libnss3.so' <<<"${MISSING:-}"; then
  echo "sudo apt install -y libnss3"
fi
if grep -q 'libatk-bridge-2.0.so.0' <<<"${MISSING:-}"; then
  echo "sudo apt install -y libatk-bridge2.0-0"
fi
if grep -q 'libxkbcommon.so.0' <<<"${MISSING:-}"; then
  echo "sudo apt install -y libxkbcommon0"
fi
if grep -q 'libgbm.so.1' <<<"${MISSING:-}"; then
  echo "sudo apt install -y libgbm1"
fi
if grep -q 'libasound.so.2' <<<"${MISSING:-}"; then
  echo "sudo apt install -y libasound2 || sudo apt install -y libasound2t64"
fi

echo
echo "== Smoke launch =="
if [[ -z "${MISSING}" ]]; then
  "${BIN}" --version || true
else
  echo "Skipped because required shared libraries are missing."
fi
