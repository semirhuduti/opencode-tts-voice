import { describe, expect, it } from "bun:test"
import { adjustVoiceSpeed, createVoiceSpeedController, scalePauseForSpeed } from "../src/voice-speed.js"

function speedStorage(initial: number | null = null) {
  const state = { speed: initial }
  return {
    state,
    store(_key: string, _options: { initial: { speed: number | null } }) {
      return [state, async (mutation: (draft: { speed: number | null }) => void) => mutation(state)] as const
    },
  }
}

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

  it("remembers adjustments and restores them on a later load", async () => {
    const storage = speedStorage()
    const first = createVoiceSpeedController(undefined, 1, storage, () => {})
    expect(first.speed).toBe(1)
    expect(first.adjust(1)).toBe(1.25)
    expect(first.adjust(1)).toBe(1.5)
    await first.flush()
    expect(storage.state.speed).toBe(1.5)
    expect(createVoiceSpeedController(undefined, 1, storage, () => {}).speed).toBe(1.5)
  })

  it("uses configured speed on each load without changing the remembered speed", async () => {
    const storage = speedStorage(1.5)
    const first = createVoiceSpeedController(0.75, 0.75, storage, () => {})
    expect(first.speed).toBe(0.75)
    expect(first.adjust(1)).toBe(1)
    await first.flush()
    expect(storage.state.speed).toBe(1.5)
    expect(createVoiceSpeedController(0.75, 0.75, storage, () => {}).speed).toBe(0.75)
    expect(createVoiceSpeedController(undefined, 1, storage, () => {}).speed).toBe(1.5)
  })

  it("ignores invalid configured and saved speeds", () => {
    const storage = speedStorage(Number.NaN)
    expect(createVoiceSpeedController(0, 1, storage, () => {}).speed).toBe(1)
    storage.state.speed = 1.25
    expect(createVoiceSpeedController("fast", 1, storage, () => {}).speed).toBe(1.25)
    expect(createVoiceSpeedController(Infinity, 1, storage, () => {}).speed).toBe(1.25)
  })

  it("reports save failures and continues saving later adjustments", async () => {
    const errors: unknown[] = []
    const state = { speed: null as number | null }
    let attempts = 0
    const storage = {
      store() {
        return [state, async (mutation: (draft: typeof state) => void) => {
          if (++attempts === 1) throw new Error("storage unavailable")
          mutation(state)
        }] as const
      },
    }
    const controller = createVoiceSpeedController(undefined, 1, storage, (error) => errors.push(error))
    controller.adjust(1)
    controller.adjust(1)
    await controller.flush()
    expect(errors).toHaveLength(1)
    expect(state.speed).toBe(1.5)
  })
})
