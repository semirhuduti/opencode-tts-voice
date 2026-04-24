type LogFields = Record<string, unknown>

const LOG_PREFIX = "[opencode-tts-voice]"

function normalize(fields?: LogFields) {
  if (!fields) return undefined
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

function write(method: "info" | "warn" | "error", scope: string, message: string, fields?: LogFields) {
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
