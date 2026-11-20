import { describe, expect, it } from "bun:test"
import { SessionStore } from "../../src/session/session-store.js"

type Handler = (event: { data: Record<string, never> }) => void

function createApi(getSession: (sessionID: string) => Promise<{ id: string; parentID?: string }>) {
  const handlers = new Map<string, Handler>()
  return {
    data: {
      on(name: string, handler: Handler) {
        handlers.set(name, handler)
        return () => handlers.delete(name)
      },
    },
    client: {
      session: {
        get: ({ sessionID }: { sessionID: string }) => getSession(sessionID),
      },
    },
  }
}

describe("SessionStore", () => {
  it("caches and deduplicates parent lookups", async () => {
    let calls = 0
    const api = createApi(async (sessionID) => {
      calls += 1
      return { id: sessionID, parentID: "parent" }
    })
    const store = new SessionStore(api as never, false)

    const [first, second] = await Promise.all([store.sessionParentID("child"), store.sessionParentID("child")])
    const third = await store.sessionParentID("child")

    expect(first).toBe("parent")
    expect(second).toBe("parent")
    expect(third).toBe("parent")
    expect(calls).toBe(1)
  })

  it("allows subagents only when configured", async () => {
    const api = createApi(async (sessionID) => ({ id: sessionID, parentID: "parent" }))
    const disabled = new SessionStore(api as never, false)
    const enabled = new SessionStore(api as never, true)

    expect(await disabled.shouldSpeakSession("child")).toBe(false)
    expect(await enabled.shouldSpeakSession("child")).toBe(true)
  })

  it("does not speak when a session lookup fails", async () => {
    const api = createApi(async () => { throw new Error("missing") })
    const store = new SessionStore(api as never, false)

    expect(await store.shouldSpeakSession("unknown")).toBe(false)
  })

  it("notifies deletion callbacks", () => {
    const api = createApi(async (sessionID) => ({ id: sessionID }))
    const store = new SessionStore(api as never, false)
    const deleted: string[] = []
    store.onDeleted((sessionID) => deleted.push(sessionID))

    store.forgetSession("session-1")

    expect(deleted).toEqual(["session-1"])
  })
})
