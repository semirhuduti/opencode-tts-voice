import type { VoiceConfig } from "./voice-types.js"

export const PLUGIN_ID = "semirhuduti.tts.voice"
export const KV_ENABLED = `${PLUGIN_ID}.enabled`
export const DEFAULT_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX"

export const DEFAULT_CONFIG: VoiceConfig = {
  voice: "af_heart",
  speed: 1,
  device: "auto",
  dtype: "q8",
  model: DEFAULT_MODEL,
  cacheDir: undefined,
  playerBin: "ffplay",
  playerArgs: [],
  readResponses: true,
  announceOnIdle: false,
  idleMessage: "Task completed.",
  speechChunkLength: 1000,
  streamSoftLimit: 180,
  maxTextLength: 2000,
  trimSilenceThreshold: 0.001,
  leadingAudioPadMs: 12,
  defaultChunkPauseMs: 50,
  clauseChunkPauseMs: 80,
  shortcuts: {
    pause: "f6",
    skipLatest: "f7",
    toggle: "f8",
  },
}

export const PLAYER_DEFAULT_ARGS: Record<string, string[]> = {
  ffplay: ["-nodisp", "-autoexit", "-loglevel", "error"],
  mpv: ["--no-terminal", "--really-quiet", "--force-window=no", "--audio-display=no", "--keep-open=no"],
}
