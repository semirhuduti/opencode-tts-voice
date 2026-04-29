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

function completedMessage(id: string, created: number, overrides: Record<string, unknown> = {}) {
  return {
    ...baseMessage,
    id,
    time: { created, completed: created + 1 },
    ...overrides,
  }
}

function textPart(text: string, overrides: Record<string, unknown> = {}) {
  return { id: `part-${text}`, type: "text", text, synthetic: false, ignored: false, ...overrides }
}

function createApi(messages: unknown[], parts: unknown[] | Record<string, unknown[]>) {
  return {
    client: {
      session: {
        messages: async () => ({ data: [] }),
      },
    },
    state: {
      session: {
        messages: () => messages,
      },
      part: (messageID: string) => Array.isArray(parts) ? parts : parts[messageID] ?? [],
    },
  }
}

function createSessionStore(shouldSpeakSession = true) {
  const callbacks = new Set<(sessionID: string) => void>()
  return {
    onDeleted(callback: (sessionID: string) => void) {
      callbacks.add(callback)
      return () => callbacks.delete(callback)
    },
    shouldSpeakSession: async () => shouldSpeakSession,
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

  it("uses configured extensions for replay text", () => {
    const api = createApi([baseMessage], [{ id: "part-1", type: "text", text: "Open app/widget.foo", synthetic: false, ignored: false }])
    const timers = new TimerRegistry()
    const sessionStore = createSessionStore()
    const latest = new LatestMessageStore(api as never, { ...DEFAULT_CONFIG, fileExtensions: ["foo"] }, timers, sessionStore as never)

    expect(latest.collectLatestMessageText("session-1")).toBe("Open the widget foo file in the app folder.")
    timers.dispose()
  })

  it("collects playable completed assistant history newest first and capped", async () => {
    const messages = [
      completedMessage("user", 1, { role: "user" }),
      completedMessage("summary", 2, { summary: true }),
      { ...completedMessage("incomplete", 3), time: { created: 3 } },
      completedMessage("empty", 4),
      ...Array.from({ length: 52 }, (_, index) => completedMessage(`message-${index}`, 10 + index)),
    ]
    const parts = Object.fromEntries(
      Array.from({ length: 52 }, (_, index) => [`message-${index}`, [textPart(`Message ${index}.`)]]),
    )
    const api = createApi(messages, { ...parts, empty: [textPart("", { ignored: true })] })
    const timers = new TimerRegistry()
    const sessionStore = createSessionStore()
    const latest = new LatestMessageStore(api as never, DEFAULT_CONFIG, timers, sessionStore as never)

    const history = await latest.collectDisplayHistory("session-1")

    expect(history).toHaveLength(50)
    expect(history[0]?.messageID).toBe("message-51")
    expect(history.at(-1)?.messageID).toBe("message-2")
    expect(history.some((entry) => ["user", "summary", "incomplete", "empty"].includes(entry.messageID))).toBe(false)
    timers.dispose()
  })

  it("loads playable history from the session API when state has no messages", async () => {
    const api = {
      ...createApi([], []),
      client: {
        session: {
          messages: async () => ({
            data: [
              { info: completedMessage("old-1", 1), parts: [textPart("Old one.")] },
              { info: completedMessage("old-2", 2), parts: [textPart("Old two.")] },
            ],
          }),
        },
      },
    }
    const timers = new TimerRegistry()
    const sessionStore = createSessionStore()
    const latest = new LatestMessageStore(api as never, DEFAULT_CONFIG, timers, sessionStore as never)

    const history = await latest.collectDisplayHistory("session-1")

    expect(history.map((entry) => entry.messageID)).toEqual(["old-2", "old-1"])
    expect(await latest.collectContinuationHistory("session-1", "old-1")).toMatchObject([
      { messageID: "old-1", text: "Old one." },
      { messageID: "old-2", text: "Old two." },
    ])
    expect(await latest.hasPlayableHistory("session-1")).toBe(true)
    timers.dispose()
  })

  it("returns chronological continuation history from the selected message", async () => {
    const api = createApi(
      [completedMessage("first", 1), completedMessage("second", 2), completedMessage("third", 3)],
      {
        first: [textPart("First.")],
        second: [textPart("Second.")],
        third: [textPart("Third.")],
      },
    )
    const timers = new TimerRegistry()
    const sessionStore = createSessionStore()
    const latest = new LatestMessageStore(api as never, DEFAULT_CONFIG, timers, sessionStore as never)

    const continuation = await latest.collectContinuationHistory("session-1", "second")

    expect(continuation.map((entry) => entry.messageID)).toEqual(["second", "third"])
    timers.dispose()
  })

  it("does not expose history when session speech is blocked", async () => {
    const api = createApi([completedMessage("message-1", 1)], { "message-1": [textPart("Blocked.")] })
    const timers = new TimerRegistry()
    const sessionStore = createSessionStore(false)
    const latest = new LatestMessageStore(api as never, DEFAULT_CONFIG, timers, sessionStore as never)

    expect(await latest.collectDisplayHistory("session-1")).toEqual([])
    expect(await latest.collectContinuationHistory("session-1", "message-1")).toEqual([])
    expect(await latest.hasPlayableHistory("session-1")).toBe(false)
    timers.dispose()
  })
})
