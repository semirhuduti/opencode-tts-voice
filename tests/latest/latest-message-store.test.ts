import { describe, expect, it } from "bun:test"
import { DEFAULT_CONFIG } from "../../src/voice-constants.js"
import { LatestMessageStore } from "../../src/latest/latest-message-store.js"

function assistant(id: string, text: string, created: number, completed = true) {
  return {
    id,
    type: "assistant",
    time: { created, completed: completed ? created + 1 : undefined },
    content: [{ type: "text", text }],
  }
}

function harness(messages: unknown[], allowed = true) {
  const api = {
    data: {
      session: {
        message: {
          list: () => messages,
          sync: async () => {},
        },
      },
    },
  }
  const sessions = {
    onDeleted: () => () => {},
    shouldSpeakSession: async () => allowed,
  }
  return new LatestMessageStore(api as never, DEFAULT_CONFIG, sessions as never)
}

describe("LatestMessageStore V2", () => {
  it("lists completed assistant messages newest first", async () => {
    const store = harness([
      { type: "user", id: "user", time: { created: 0 }, text: "Ignored" },
      assistant("first", "First.", 1),
      assistant("second", "Second.", 2),
      assistant("pending", "Not finished.", 3, false),
    ])
    expect((await store.collectDisplayHistory("session")).map((entry) => entry.messageID)).toEqual(["second", "first"])
    expect((await store.replayText("session")).text).toBe("Second.")
  })

  it("replays from a selected message in chronological order", async () => {
    const store = harness([assistant("first", "First.", 1), assistant("second", "Second.", 2)])
    expect((await store.collectContinuationHistory("session", "first")).map((entry) => entry.text)).toEqual(["First.", "Second."])
  })

  it("does not expose history for blocked sessions", async () => {
    const store = harness([assistant("first", "Secret.", 1)], false)
    expect(await store.collectDisplayHistory("session")).toEqual([])
  })
})
