import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

type LogFields = Record<string, unknown>
type LogLevel = "debug" | "info" | "warn" | "error" | "silent"

const LOG_PREFIX = "[opencode-tts-voice]"
const LOG_FILE_PREFIX = "opencode-tts-voice"
const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
}

let logFile: string | undefined
let fileLogDisabled = false

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

function timestampForFile(date: Date) {
  return date.toISOString().replace(/:/g, "").replace(/\.\d{3}Z$/, "")
}

function resolveLogFile() {
  if (fileLogDisabled) return undefined
  if (logFile) return logFile

  const home = os.homedir()
  if (!process.env.XDG_DATA_HOME && !home) {
    fileLogDisabled = true
    return undefined
  }

  const dataDir = process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share")
  const dir = path.join(dataDir, "opencode", "log")
  const file = path.join(dir, `${LOG_FILE_PREFIX}-${timestampForFile(new Date())}.log`)

  try {
    fs.mkdirSync(dir, { recursive: true })
    logFile = file
    return file
  } catch {
    fileLogDisabled = true
    return undefined
  }
}

function formatFields(fields?: LogFields) {
  if (!fields || Object.keys(fields).length === 0) return ""
  try {
    return ` ${JSON.stringify(fields)}`
  } catch {
    return ` ${String(fields)}`
  }
}

function writeFile(method: "debug" | "info" | "warn" | "error", scope: string, message: string, fields?: LogFields) {
  const file = resolveLogFile()
  if (!file) return

  try {
    fs.appendFileSync(file, `${new Date().toISOString()} ${method.toUpperCase()} ${scope} ${message}${formatFields(fields)}\n`)
  } catch {
    fileLogDisabled = true
  }
}

function write(method: "debug" | "info" | "warn" | "error", scope: string, message: string, fields?: LogFields) {
  if (LEVELS[method] < LEVELS[readLevel()]) return

  const payload = normalize(fields)
  const line = `${LOG_PREFIX} ${scope} ${message}`
  writeFile(method, scope, message, payload)
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
