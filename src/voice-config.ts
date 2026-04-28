import { DEFAULT_CONFIG } from "./voice-constants.js"
import { normalizeFileExtensions } from "./voice-sanitize.js"
import type {
  DevicePreference,
  KokoroDType,
  ShortcutConfig,
  VoiceBlock,
  VoiceConfig,
  VoicePluginOptions,
} from "./voice-types.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function readString(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback
  const next = value.trim()
  return next || fallback
}

function readOptionalString(value: unknown) {
  if (typeof value !== "string") return undefined
  const next = value.trim()
  return next || undefined
}

function readBoolean(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value
  return fallback
}

function readNumber(value: unknown, fallback: number, min?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  if (min !== undefined && value < min) return fallback
  return value
}

function readInteger(value: unknown, fallback: number, min = 0) {
  const next = readNumber(value, fallback, min)
  return Math.floor(next)
}

function readStringList(value: unknown, fallback: string[]) {
  if (typeof value === "string") {
    const next = value.trim()
    return next ? [next] : fallback
  }

  if (!Array.isArray(value)) return fallback
  const next = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
  return next.length ? next : fallback
}

function readDevice(value: unknown): DevicePreference {
  switch (value) {
    case "auto":
    case "cpu":
    case "gpu":
    case "cuda":
    case "dml":
    case "wasm":
    case "webgpu":
      return value
    default:
      return DEFAULT_CONFIG.device
  }
}

function readDType(value: unknown): KokoroDType {
  switch (value) {
    case "fp32":
    case "fp16":
    case "q4":
    case "q4f16":
    case "q8":
      return value
    default:
      return DEFAULT_CONFIG.dtype
  }
}

function isVoiceBlock(value: unknown): value is VoiceBlock {
  return value === "reason" || value === "message" || value === "idle"
}

function readVoiceBlocks(value: unknown): VoiceBlock[] {
  if (Array.isArray(value) && value.length === 0) return []

  const input = Array.isArray(value) ? value : typeof value === "string" ? [value] : DEFAULT_CONFIG.speechBlocks
  const next: VoiceBlock[] = []

  for (const item of input) {
    if (!isVoiceBlock(item) || next.includes(item)) continue
    next.push(item)
  }

  return next.length ? next : [...DEFAULT_CONFIG.speechBlocks]
}

function readShortcuts(value: unknown): ShortcutConfig {
  if (!isRecord(value)) return { ...DEFAULT_CONFIG.shortcuts }
  return {
    pause: readString(value.pause, DEFAULT_CONFIG.shortcuts.pause),
    skipLatest: readString(value.skipLatest, DEFAULT_CONFIG.shortcuts.skipLatest),
    toggle: readString(value.toggle, DEFAULT_CONFIG.shortcuts.toggle),
  }
}

export function resolveVoiceConfig(options: VoicePluginOptions | undefined): VoiceConfig {
  const input: Record<string, unknown> = isRecord(options) ? options : {}
  const maxSpeechChunkChars = readInteger(input.maxSpeechChunkChars, DEFAULT_CONFIG.maxSpeechChunkChars, 32)
  const streamFlushChars = Math.min(
    maxSpeechChunkChars,
    readInteger(input.streamFlushChars, DEFAULT_CONFIG.streamFlushChars, 16),
  )

  return {
    voice: readString(input.voice, DEFAULT_CONFIG.voice),
    speed: readNumber(input.speed, DEFAULT_CONFIG.speed, 0.1),
    device: readDevice(input.device),
    dtype: readDType(input.dtype),
    model: readString(input.model, DEFAULT_CONFIG.model),
    cacheDir: readOptionalString(input.cacheDir),
    audioPlayer: readString(input.audioPlayer, DEFAULT_CONFIG.audioPlayer),
    audioPlayerArgs: readStringList(input.audioPlayerArgs, DEFAULT_CONFIG.audioPlayerArgs),
    speakResponses: readBoolean(input.speakResponses, DEFAULT_CONFIG.speakResponses),
    speakSubagentResponses: readBoolean(input.speakSubagentResponses, DEFAULT_CONFIG.speakSubagentResponses),
    speakOnIdle: readBoolean(input.speakOnIdle, DEFAULT_CONFIG.speakOnIdle),
    idleAnnouncement: readString(input.idleAnnouncement, DEFAULT_CONFIG.idleAnnouncement),
    speechBlocks: readVoiceBlocks(input.speechBlocks),
    maxSpeechChunkChars,
    streamFlushChars,
    maxSpeechChars: readInteger(input.maxSpeechChars, DEFAULT_CONFIG.maxSpeechChars, 64),
    fileExtensions: normalizeFileExtensions(input.fileExtensions),
    trimSilenceThreshold: readNumber(
      input.trimSilenceThreshold,
      DEFAULT_CONFIG.trimSilenceThreshold,
      0,
    ),
    leadingAudioPadMs: readInteger(input.leadingAudioPadMs, DEFAULT_CONFIG.leadingAudioPadMs, 0),
    normalPauseMs: readInteger(input.normalPauseMs, DEFAULT_CONFIG.normalPauseMs, 0),
    sentencePauseMs: readInteger(input.sentencePauseMs, DEFAULT_CONFIG.sentencePauseMs, 0),
    shortcuts: readShortcuts(input.shortcuts),
  }
}
