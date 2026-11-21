#!/bin/sh
set -eu

if ! command -v opencode >/dev/null 2>&1; then
  printf '%s\n' "Error: opencode was not found on PATH." >&2
  exit 1
fi

opencode plugin update "@scotteza/opencode-spoken-replies"
