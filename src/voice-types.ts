export type DevicePreference = "auto" | "cpu" | "gpu" | "cuda" | "dml" | "wasm" | "webgpu"

export type KokoroRuntimeDevice = "cpu" | "wasm" | "webgpu"

export type KokoroDType = "fp32" | "fp16" | "q4" | "q4f16" | "q8"

export type VoiceBlock = "reason" | "message" | "idle"

export type VoicePluginOptions = {
  voice?: unknown
  speed?: unknown
  device?: unknown
  dtype?: unknown
  model?: unknown
  cacheDir?: unknown
  playerBin?: unknown
  playerArgs?: unknown
  readResponses?: unknown
  announceOnIdle?: unknown
  idleMessage?: unknown
  voiceBlocks?: unknown
  speechChunkLength?: unknown
  streamSoftLimit?: unknown
  maxTextLength?: unknown
  trimSilenceThreshold?: unknown
  leadingAudioPadMs?: unknown
  defaultChunkPauseMs?: unknown
  clauseChunkPauseMs?: unknown
  shortcuts?: unknown
}

export type ShortcutConfig = {
  pause: string
  skipLatest: string
  toggle: string
}

export type VoiceConfig = {
  voice: string
  speed: number
  device: DevicePreference
  dtype: KokoroDType
  model: string
  cacheDir?: string
  playerBin: string
  playerArgs: string[]
  readResponses: boolean
  announceOnIdle: boolean
  idleMessage: string
  voiceBlocks: VoiceBlock[]
  speechChunkLength: number
  streamSoftLimit: number
  maxTextLength: number
  trimSilenceThreshold: number
  leadingAudioPadMs: number
  defaultChunkPauseMs: number
  clauseChunkPauseMs: number
  shortcuts: ShortcutConfig
}

export type VoiceState = {
  enabled: boolean
  paused: boolean
  busy: boolean
  generating: boolean
  playing: boolean
  backend: string
  device: string
  error?: string
}

export type SpeechSource = "stream" | "latest" | "idle"

export type PreparedChunk = {
  text: string
  pauseMs: number
}
