import { describe, expect, it } from "bun:test"
import { DEFAULT_CONFIG } from "../../src/voice-constants.js"
import { StreamBuffer } from "../../src/streaming/stream-buffer.js"

describe("StreamBuffer", () => {
  it("accumulates deltas and drains chunks", () => {
    const config = { ...DEFAULT_CONFIG, streamFlushChars: 10, maxSpeechChunkChars: 30 }
    const buffer = new StreamBuffer("session", "message", "message")

    const first = buffer.applyDelta("Hello", "message", config, true)
    const second = buffer.applyDelta(" world. Again", "message", config, false)

    expect(first.chunks).toEqual([])
    expect(second.chunks.map((chunk) => chunk.text)).toEqual(["Hello world."])
    expect(buffer.rawText).toBe("Hello world. Again")
    expect(buffer.completed).toBe(false)
  })

  it("flushes final text and marks completion", () => {
    const config = { ...DEFAULT_CONFIG, streamFlushChars: 50, maxSpeechChunkChars: 100 }
    const buffer = new StreamBuffer("session", "message", "message")
    buffer.applyDelta("Hello", "message", config, true)

    const result = buffer.applyFinal("Hello world.", "message", config, false)

    expect(result.cursorReset).toBe(false)
    expect(result.nextText).toBe(" world.")
    expect(result.chunks.map((chunk) => chunk.text)).toEqual(["Hello world."])
    expect(buffer.completed).toBe(true)
  })

  it("reports cursor reset when final text diverges", () => {
    const config = { ...DEFAULT_CONFIG, streamFlushChars: 50, maxSpeechChunkChars: 100 }
    const buffer = new StreamBuffer("session", "message", "message")
    buffer.applyDelta("Hello", "message", config, true)

    const result = buffer.applyFinal("Different text.", "message", config, false)

    expect(result.cursorReset).toBe(true)
    expect(result.nextText).toBe("")
    expect(buffer.rawText).toBe("Different text.")
    expect(buffer.completed).toBe(true)
  })

  it("uses configured extensions while streaming", () => {
    const config = { ...DEFAULT_CONFIG, fileExtensions: ["foo"], streamFlushChars: 10, maxSpeechChunkChars: 100 }
    const buffer = new StreamBuffer("session", "message", "message")

    const result = buffer.applyFinal("Open app/widget.foo", "message", config, true)

    expect(result.chunks.map((chunk) => chunk.text)).toEqual(["Open the widget foo file in the app folder."])
  })
})
