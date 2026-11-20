import { describe, expect, it } from "bun:test"
import server from "../src/server-plugin.js"

describe("V2 server plugin", () => {
  it("registers the voice state RPC and adds guidance only when enabled", async () => {
    let enabled = true
    let hook: ((event: { sessionID: string; system: Array<{ type: string; text: string }> }) => Promise<void>) | undefined
    let handlers: {
      getEnabled: () => Promise<{ enabled: boolean }>
      setEnabled: (input: { enabled: boolean }) => Promise<{ enabled: boolean }>
    } | undefined
    const emitted: unknown[] = []
    const context = {
      storage: {
        get: async () => enabled,
        set: async (_key: string, value: boolean) => { enabled = value },
      },
      rpc: {
        register: async (_definition: unknown, next: typeof handlers) => {
          handlers = next
          return { events: { emit: async (_name: string, value: unknown) => { emitted.push(value) } } }
        },
      },
      session: { hook: async (_name: string, next: typeof hook) => { hook = next } },
    }
    await server.setup(context as never)
    const event = { sessionID: "session", system: [] as Array<{ type: string; text: string }> }
    await hook?.(event)
    expect(event.system[0]?.text).toContain("TTS Friendly Responses")

    await handlers?.setEnabled({ enabled: false })
    const disabled = { sessionID: "session", system: [] as Array<{ type: string; text: string }> }
    await hook?.(disabled)
    expect(disabled.system).toEqual([])
    expect(await handlers?.getEnabled()).toEqual({ enabled: false })
    expect(emitted).toEqual([{ enabled: false }])
  })
})
