#!/bin/sh

run_step() {
  label=$1
  shift

  printf '\n==> %s\n' "$label"
  "$@"
  status=$?
  if [ "$status" -ne 0 ]; then
    printf '\033[31mERROR: %s failed (exit code %s).\033[0m\n' "$label" "$status" >&2
    exit "$status"
  fi
}

run_step "Installing dependencies" npm install
run_step "Building the project" npm run build
run_step "Running automated tests" npm test
run_step "Running the audio test with playback" env OPENCODE_TTS_TEST_PLAY=1 npm run test:audio

printf '\033[32mAll build and test steps passed.\033[0m\n'
