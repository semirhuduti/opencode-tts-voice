import { describe, expect, it } from "bun:test"
import { DEFAULT_CONFIG } from "../../src/voice-constants.js"
import { LatestMessageStore } from "../../src/latest/latest-message-store.js"
import { TimerRegistry } from "../../src/shared/timer-registry.js"

const baseMessage = {
  id: "message-1",
  sessionID: "session-1",
  role: "assistant",
  time: {},
}

function createApi(messages: unknown[], parts: unknown[]) {
  return {
    state: {
      session: {
        messages: () => messages,
      },
      part: () => parts,
    },
  }
}

function createSessionStore() {
  const callbacks = new Set<(sessionID: string) => void>()
  return {
    onDeleted(callback: (sessionID: string) => void) {
      callbacks.add(callback)
      return () => callbacks.delete(callback)
    },
    shouldSpeakSession: async () => true,
    delete(sessionID: string) {
      for (const callback of callbacks) callback(sessionID)
    },
  }
}

describe("LatestMessageStore", () => {
  it("collects latest assistant text and ignores summaries", () => {
    const api = createApi(
      [
        { ...baseMessage, id: "summary", summary: true },
        { ...baseMessage, id: "user", role: "user" },
        { ...baseMessage, id: "message-1" },
      ],
      [{ id: "part-1", type: "text", text: "Hello there.", synthetic: false, ignored: false }],
    )
    const timers = new TimerRegistry()
    const sessionStore = createSessionStore()
    const latest = new LatestMessageStore(api as never, DEFAULT_CONFIG, timers, sessionStore as never)

    expect(latest.collectLatestMessageText("session-1")).toBe("Hello there.")
    timers.dispose()
  })

  it("respects speech block filtering", () => {
    const api = createApi([baseMessage], [{ id: "part-1", type: "reasoning", text: "Thinking." }])
    const timers = new TimerRegistry()
    const sessionStore = createSessionStore()
    const latest = new LatestMessageStore(api as never, { ...DEFAULT_CONFIG, speechBlocks: ["message"] }, timers, sessionStore as never)

    expect(latest.collectLatestMessageText("session-1")).toBeUndefined()
    timers.dispose()
  })

  it("clears cached text on session deletion", async () => {
    const api = createApi([baseMessage], [{ id: "part-1", type: "text", text: "Cached text.", synthetic: false, ignored: false }])
    const timers = new TimerRegistry()
    const sessionStore = createSessionStore()
    const latest = new LatestMessageStore(api as never, DEFAULT_CONFIG, timers, sessionStore as never)

    latest.scheduleLatestRefresh("session-1", "message-1")
    await timers.sleep(1)
    expect(latest.replayText("session-1").source).toBe("cache")

    sessionStore.delete("session-1")
    expect(latest.replayText("session-1").source).toBe("state")
    timers.dispose()
  })
})
