import { describe, expect, it } from "bun:test"
import { adjustVoiceSpeed, scalePauseForSpeed } from "../src/voice-speed.js"

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

  it("scales configured pauses inversely with speech speed", () => {
    expect(scalePauseForSpeed(420, 1)).toBe(420)
    expect(scalePauseForSpeed(420, 1.25)).toBe(336)
    expect(scalePauseForSpeed(420, 0.75)).toBe(560)
    expect(scalePauseForSpeed(240, 2)).toBe(120)
    expect(scalePauseForSpeed(0, 1.25)).toBe(0)
  })
})
