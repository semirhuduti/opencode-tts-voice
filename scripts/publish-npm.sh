#!/bin/sh

printf 'Publishing @scotteza/opencode-spoken-replies to npm...\n'

if npm run publish:npm; then
  printf '\033[32mPackage published successfully.\033[0m\n'
else
  status=$?
  printf '\033[31mERROR: npm publish failed (exit code %s).\033[0m\n' "$status" >&2
  exit "$status"
fi
