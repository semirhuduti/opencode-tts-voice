type LogFields = Record<string, unknown>
type LogLevel = "debug" | "info" | "warn" | "error" | "silent"

const LOG_PREFIX = "[opencode-tts-voice]"
const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
}

function readLevel(): LogLevel {
  const value = process.env.OPENCODE_TTS_VOICE_LOG_LEVEL ?? process.env.OPENCODE_TTS_LOG_LEVEL
  switch (value?.toLowerCase()) {
    case "debug":
    case "info":
    case "warn":
    case "error":
    case "silent":
      return value.toLowerCase() as LogLevel
    default:
      return "warn"
  }
}

function normalize(fields?: LogFields) {
  if (!fields) return undefined
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

function write(method: "debug" | "info" | "warn" | "error", scope: string, message: string, fields?: LogFields) {
  if (LEVELS[method] < LEVELS[readLevel()]) return

  const payload = normalize(fields)
  const line = `${LOG_PREFIX} ${scope} ${message}`
  if (payload && Object.keys(payload).length > 0) {
    console[method](line, payload)
    return
  }
  console[method](line)
}

export function createLogger(scope: string) {
  return {
    debug(message: string, fields?: LogFields) {
      write("debug", scope, message, fields)
    },
    info(message: string, fields?: LogFields) {
      write("info", scope, message, fields)
    },
    warn(message: string, fields?: LogFields) {
      write("warn", scope, message, fields)
    },
    error(message: string, fields?: LogFields) {
      write("error", scope, message, fields)
    },
  }
}

export type VoiceLogger = ReturnType<typeof createLogger>
