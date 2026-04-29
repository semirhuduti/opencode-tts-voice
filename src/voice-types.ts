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
  audioPlayer?: unknown
  audioPlayerArgs?: unknown
  speakResponses?: unknown
  speakSubagentResponses?: unknown
  speakOnIdle?: unknown
  speakQuestions?: unknown
  idleAnnouncement?: unknown
  speechBlocks?: unknown
  maxSpeechChunkChars?: unknown
  streamFlushChars?: unknown
  maxSpeechChars?: unknown
  fileExtensions?: unknown
  trimSilenceThreshold?: unknown
  leadingAudioPadMs?: unknown
  normalPauseMs?: unknown
  sentencePauseMs?: unknown
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
  audioPlayer: string
  audioPlayerArgs: string[]
  speakResponses: boolean
  speakSubagentResponses: boolean
  speakOnIdle: boolean
  speakQuestions: boolean
  idleAnnouncement: string
  speechBlocks: VoiceBlock[]
  maxSpeechChunkChars: number
  streamFlushChars: number
  maxSpeechChars: number
  fileExtensions: string[]
  trimSilenceThreshold: number
  leadingAudioPadMs: number
  normalPauseMs: number
  sentencePauseMs: number
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

export type SpeechSource = "stream" | "latest" | "idle" | "question"

export type PreparedChunk = {
  text: string
  pauseMs: number
}
