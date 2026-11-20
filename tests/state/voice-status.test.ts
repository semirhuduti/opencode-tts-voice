import { describe, expect, it } from "bun:test"
import { voiceStatusLabel } from "../../src/state/voice-status.js"

describe("voice status", () => {
  it("distinguishes loading from normal speech and respects off and error states", () => {
    expect(voiceStatusLabel({ enabled: true, device: "cpu" })).toBe("sound on")
    expect(voiceStatusLabel({ enabled: true, device: "loading" })).toBe("sound initializing")
    expect(voiceStatusLabel({ enabled: false, device: "loading" })).toBe("sound off")
    expect(voiceStatusLabel({ enabled: true, device: "loading", error: "failed" })).toBe("! sound error")
  })
})
