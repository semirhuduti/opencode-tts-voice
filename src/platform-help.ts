export function nodeRuntimeInstallHint(platform = process.platform) {
  if (platform === "win32") {
    return "On Windows, install Node.js LTS with `winget install --id OpenJS.NodeJS.LTS --exact`, then restart OpenCode."
  }
  return "Install Node.js or Bun and make sure it is available on PATH, then restart OpenCode."
}

export function audioPlayerInstallHint(platform = process.platform) {
  if (platform === "win32") {
    return "On Windows, install ffplay with `winget install --id Gyan.FFmpeg -e`, then restart OpenCode."
  }
  if (platform === "darwin") {
    return "Install an audio player such as ffplay (`brew install ffmpeg`) or mpv, then restart OpenCode."
  }
  return "Install ffplay or mpv and make sure it is available on PATH (on Ubuntu/Debian, run `sudo apt install ffmpeg`)."
}
