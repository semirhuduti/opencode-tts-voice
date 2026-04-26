import { DEFAULT_CONFIG } from "./voice-constants.js"
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

function readPercent(value: unknown, fallback: number) {
  const next = readNumber(value, fallback, 0)
  if (next > 100) return fallback
  return next
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

  const input = Array.isArray(value) ? value : typeof value === "string" ? [value] : DEFAULT_CONFIG.voiceBlocks
  const next: VoiceBlock[] = []

  for (const item of input) {
    if (!isVoiceBlock(item) || next.includes(item)) continue
    next.push(item)
  }

  return next.length ? next : [...DEFAULT_CONFIG.voiceBlocks]
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
  const speechChunkLength = readInteger(input.speechChunkLength, DEFAULT_CONFIG.speechChunkLength, 32)
  const streamSoftLimit = Math.min(
    speechChunkLength,
    readInteger(input.streamSoftLimit, DEFAULT_CONFIG.streamSoftLimit, 16),
  )

  return {
    voice: readString(input.voice, DEFAULT_CONFIG.voice),
    speed: readNumber(input.speed, DEFAULT_CONFIG.speed, 0.1),
    device: readDevice(input.device),
    dtype: readDType(input.dtype),
    model: readString(input.model, DEFAULT_CONFIG.model),
    cacheDir: readOptionalString(input.cacheDir),
    playerBin: readString(input.playerBin, DEFAULT_CONFIG.playerBin),
    playerArgs: readStringList(input.playerArgs, DEFAULT_CONFIG.playerArgs),
    readResponses: readBoolean(input.readResponses, DEFAULT_CONFIG.readResponses),
    announceOnIdle: readBoolean(input.announceOnIdle, DEFAULT_CONFIG.announceOnIdle),
    idleMessage: readString(input.idleMessage, DEFAULT_CONFIG.idleMessage),
    voiceBlocks: readVoiceBlocks(input.voiceBlocks ?? input["voice-blocks"]),
    speechChunkLength,
    streamSoftLimit,
    maxTextLength: readInteger(input.maxTextLength, DEFAULT_CONFIG.maxTextLength, 64),
    cpuLimitPercent: readPercent(input.cpuLimitPercent, DEFAULT_CONFIG.cpuLimitPercent),
    cpuLimitConcurrency: readInteger(
      input.cpuLimitConcurrency,
      DEFAULT_CONFIG.cpuLimitConcurrency,
      1,
    ),
    trimSilenceThreshold: readNumber(
      input.trimSilenceThreshold,
      DEFAULT_CONFIG.trimSilenceThreshold,
      0,
    ),
    leadingAudioPadMs: readInteger(input.leadingAudioPadMs, DEFAULT_CONFIG.leadingAudioPadMs, 0),
    defaultChunkPauseMs: readInteger(input.defaultChunkPauseMs, DEFAULT_CONFIG.defaultChunkPauseMs, 0),
    clauseChunkPauseMs: readInteger(input.clauseChunkPauseMs, DEFAULT_CONFIG.clauseChunkPauseMs, 0),
    shortcuts: readShortcuts(input.shortcuts),
  }
}
