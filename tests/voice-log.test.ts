import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { createLogger } from "../src/voice-log.js"

const originalLevel = process.env.OPENCODE_TTS_VOICE_LOG_LEVEL
const originalConsole = process.env.OPENCODE_TTS_VOICE_CONSOLE_LOG

afterEach(() => {
  if (originalLevel === undefined) delete process.env.OPENCODE_TTS_VOICE_LOG_LEVEL
  else process.env.OPENCODE_TTS_VOICE_LOG_LEVEL = originalLevel

  if (originalConsole === undefined) delete process.env.OPENCODE_TTS_VOICE_CONSOLE_LOG
  else process.env.OPENCODE_TTS_VOICE_CONSOLE_LOG = originalConsole
})

describe("createLogger", () => {
  it("does not log to console by default", () => {
    process.env.OPENCODE_TTS_VOICE_LOG_LEVEL = "info"
    delete process.env.OPENCODE_TTS_VOICE_CONSOLE_LOG
    const info = spyOn(console, "info").mockImplementation(() => {})

    createLogger("test").info("hello", { value: 1 })

    expect(info).not.toHaveBeenCalled()
    info.mockRestore()
  })

  it("logs to console when explicitly enabled by option", () => {
    process.env.OPENCODE_TTS_VOICE_LOG_LEVEL = "info"
    const info = spyOn(console, "info").mockImplementation(() => {})

    createLogger("test", { console: true }).info("hello", { value: 1 })

    expect(info).toHaveBeenCalledWith("[opencode-tts-voice] test hello", { value: 1 })
    info.mockRestore()
  })

  it("logs to console when enabled by environment", () => {
    process.env.OPENCODE_TTS_VOICE_LOG_LEVEL = "info"
    process.env.OPENCODE_TTS_VOICE_CONSOLE_LOG = "true"
    const info = spyOn(console, "info").mockImplementation(() => {})

    createLogger("test").info("hello")

    expect(info).toHaveBeenCalledWith("[opencode-tts-voice] test hello")
    info.mockRestore()
  })
})
