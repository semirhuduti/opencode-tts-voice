#!/bin/sh

echo "Running NPM install..."
npm ci

echo "Building the project..."
npm run build

echo "Running automated tests..."
npm test

echo "Running the audio test with playback..."
OPENCODE_TTS_TEST_PLAY=1 npm run test:audio
