import { describe, expect, it } from "bun:test"
import { DEFAULT_CONFIG } from "../src/voice-constants.js"
import { resolveVoiceConfig } from "../src/voice-config.js"

describe("resolveVoiceConfig", () => {
  it("resolves renamed speech and playback options", () => {
    const config = resolveVoiceConfig({
      audioPlayer: "mpv",
      audioPlayerArgs: ["--volume=70"],
      speakResponses: false,
      speakSubagentResponses: true,
      speakOnIdle: true,
      speakQuestions: false,
      idleAnnouncement: "All done.",
      speechBlocks: ["reason", "message"],
      maxSpeechChunkChars: 500,
      streamFlushChars: 120,
      maxSpeechChars: 1500,
      fileExtensions: [".Foo", "bar", "bad-value", " ", 42],
      normalPauseMs: 100,
      sentencePauseMs: 250,
    })

    expect(config.audioPlayer).toBe("mpv")
    expect(config.audioPlayerArgs).toEqual(["--volume=70"])
    expect(config.speakResponses).toBe(false)
    expect(config.speakSubagentResponses).toBe(true)
    expect(config.speakOnIdle).toBe(true)
    expect(config.speakQuestions).toBe(false)
    expect(config.idleAnnouncement).toBe("All done.")
    expect(config.speechBlocks).toEqual(["reason", "message"])
    expect(config.maxSpeechChunkChars).toBe(500)
    expect(config.streamFlushChars).toBe(120)
    expect(config.maxSpeechChars).toBe(1500)
    expect(config.fileExtensions).toEqual(["foo", "bar"])
    expect(config.normalPauseMs).toBe(100)
    expect(config.sentencePauseMs).toBe(250)
  })

  it("accepts a single file extension string", () => {
    const config = resolveVoiceConfig({ fileExtensions: " .FOO " })

    expect(config.fileExtensions).toEqual(["foo"])
  })

  it("filters invalid file extension entries", () => {
    const config = resolveVoiceConfig({ fileExtensions: ["foo", "d.ts", "*.vue", "bar2", "bad-value"] })

    expect(config.fileExtensions).toEqual(["foo", "bar2"])
  })

  it("does not accept removed option names as aliases", () => {
    const config = resolveVoiceConfig({
      playerBin: "mpv",
      playerArgs: ["--volume=70"],
      readResponses: false,
      readSubagentResponses: true,
      announceOnIdle: true,
      readQuestions: false,
      idleMessage: "Done.",
      voiceBlocks: ["reason"],
      speechChunkLength: 500,
      streamSoftLimit: 120,
      maxTextLength: 1500,
      defaultChunkPauseMs: 100,
      clauseChunkPauseMs: 250,
    } as Record<string, unknown>)

    expect(config.audioPlayer).toBe(DEFAULT_CONFIG.audioPlayer)
    expect(config.audioPlayerArgs).toEqual(DEFAULT_CONFIG.audioPlayerArgs)
    expect(config.speakResponses).toBe(DEFAULT_CONFIG.speakResponses)
    expect(config.speakSubagentResponses).toBe(DEFAULT_CONFIG.speakSubagentResponses)
    expect(config.speakOnIdle).toBe(DEFAULT_CONFIG.speakOnIdle)
    expect(config.speakQuestions).toBe(DEFAULT_CONFIG.speakQuestions)
    expect(config.idleAnnouncement).toBe(DEFAULT_CONFIG.idleAnnouncement)
    expect(config.speechBlocks).toEqual(DEFAULT_CONFIG.speechBlocks)
    expect(config.maxSpeechChunkChars).toBe(DEFAULT_CONFIG.maxSpeechChunkChars)
    expect(config.streamFlushChars).toBe(DEFAULT_CONFIG.streamFlushChars)
    expect(config.maxSpeechChars).toBe(DEFAULT_CONFIG.maxSpeechChars)
    expect(config.normalPauseMs).toBe(DEFAULT_CONFIG.normalPauseMs)
    expect(config.sentencePauseMs).toBe(DEFAULT_CONFIG.sentencePauseMs)
  })

  it("enables question speech by default", () => {
    const config = resolveVoiceConfig(undefined)

    expect(config.speakQuestions).toBe(true)
  })

  it("defaults and overrides the history shortcut", () => {
    expect(resolveVoiceConfig(undefined).shortcuts.history).toBe("f5")

    const config = resolveVoiceConfig({ shortcuts: { history: "ctrl+h" } })

    expect(config.shortcuts.history).toBe("ctrl+h")
    expect(config.shortcuts.pause).toBe(DEFAULT_CONFIG.shortcuts.pause)
    expect(config.shortcuts.skipLatest).toBe(DEFAULT_CONFIG.shortcuts.skipLatest)
    expect(config.shortcuts.toggle).toBe(DEFAULT_CONFIG.shortcuts.toggle)
  })
})
