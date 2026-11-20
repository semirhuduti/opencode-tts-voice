import { describe, expect, it } from "bun:test"
import { adjustVoiceSpeed } from "../src/voice-speed.js"

describe("voice speed", () => {
  it("changes speed by 0.25 in either direction", () => {
    expect(adjustVoiceSpeed(1, -1)).toBe(0.75)
    expect(adjustVoiceSpeed(1, 1)).toBe(1.25)
    expect(adjustVoiceSpeed(1.1, 1)).toBe(1.35)
  })

  it("does not go below the minimum supported speed", () => {
    expect(adjustVoiceSpeed(0.25, -1)).toBe(0.1)
    expect(adjustVoiceSpeed(0.1, -1)).toBe(0.1)
    expect(adjustVoiceSpeed(0.1, 1)).toBe(0.35)
  })
})
