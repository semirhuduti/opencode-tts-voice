import { describe, expect, it } from "bun:test"
import { StreamingController } from "../../src/streaming/streaming-controller.js"
import { DEFAULT_CONFIG } from "../../src/voice-constants.js"

describe("StreamingController V2", () => {
  it("speaks deltas and flushes the final remainder without duplicating text", async () => {
    const handlers = new Map<string, (event: { data: any }) => void>()
    const chunks: string[] = []
    const api = { ui: { router: { current: () => ({ type: "session", sessionID: "session" }) } }, data: { on: (name: string, handler: (event: { data: any }) => void) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    } } }
    const state = { snapshot: () => ({ enabled: true }) }
    const sessions = { sessionParentID: async () => undefined, onDeleted: () => () => {} }
    const playback = { enqueuePreparedChunk: (text: string) => { chunks.push(text) } }
    const controller = new StreamingController(api as never, DEFAULT_CONFIG, state as never, playback as never, sessions as never)
    const event = { sessionID: "session", assistantMessageID: "message", ordinal: 0 }

    handlers.get("session.text.delta")?.({ data: { ...event, delta: "Hello there." } })
    handlers.get("session.text.ended")?.({ data: { ...event, text: "Hello there." } })
    for (let index = 0; index < 10; index++) await Promise.resolve()
    expect(chunks.join(" ")).toBe("Hello there.")
    controller.dispose()
    expect(handlers.size).toBe(0)
  })

  it("does not replay muted text when speech is enabled mid-stream", async () => {
    const handlers = new Map<string, (event: { data: any }) => void>()
    const chunks: string[] = []
    let enabled = false
    const api = { ui: { router: { current: () => ({ type: "session", sessionID: "session" }) } }, data: { on: (name: string, handler: (event: { data: any }) => void) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    } } }
    const state = { snapshot: () => ({ enabled }) }
    const sessions = { sessionParentID: async () => undefined, onDeleted: () => () => {} }
    const playback = { enqueuePreparedChunk: (text: string) => { chunks.push(text) } }
    const controller = new StreamingController(api as never, DEFAULT_CONFIG, state as never, playback as never, sessions as never)
    const event = { sessionID: "session", assistantMessageID: "message", ordinal: 0 }

    handlers.get("session.text.delta")?.({ data: { ...event, delta: "Muted words. " } })
    for (let index = 0; index < 10; index++) await Promise.resolve()
    enabled = true
    handlers.get("session.text.ended")?.({ data: { ...event, text: "Muted words. Spoken words." } })
    for (let index = 0; index < 10; index++) await Promise.resolve()
    expect(chunks.join(" ")).not.toContain("Muted words")
    expect(chunks.join(" ")).toContain("Spoken words")
    controller.dispose()
  })
})
