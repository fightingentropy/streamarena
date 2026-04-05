#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -x "$ROOT_DIR/node_modules/.bin/vite" ]]; then
    echo "Missing frontend dependencies. Run 'bun install' or 'npm install' first." >&2
    exit 1
fi

"$ROOT_DIR/node_modules/.bin/vite" build

exec cargo run
