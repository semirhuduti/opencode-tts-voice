import { describe, expect, it } from "bun:test"
import serverPlugin from "../src/server-plugin.js"
import { resolveVoiceConfig } from "../src/voice-config.js"
import { DEFAULT_CONFIG, PLUGIN_ID } from "../src/voice-constants.js"

describe("voice plugin config", () => {
  it("applies OpenCode tuple options", () => {
    const config = resolveVoiceConfig({
      speed: 1.1,
      voice: "am_adam",
      dtype: "q4",
      shortcuts: {
        pause: "f9",
      },
    })

    expect(config.speed).toBe(1.1)
    expect(config.voice).toBe("am_adam")
    expect(config.dtype).toBe("q4")
    expect(config.shortcuts).toEqual({
      ...DEFAULT_CONFIG.shortcuts,
      pause: "f9",
    })
  })

  it("exports a no-op server plugin for runtime config compatibility", async () => {
    expect(serverPlugin.id).toBe(PLUGIN_ID)
    expect(await serverPlugin.server({} as never)).toEqual({})
  })
})
