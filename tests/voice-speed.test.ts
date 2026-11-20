import { describe, expect, it } from "bun:test"
import { adjustVoiceSpeed, createVoiceSpeedController, formatVoiceSpeed, normalizeVoiceSpeed, scalePauseForSpeed } from "../src/voice-speed.js"

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
    expect(adjustVoiceSpeed(1.1, 1)).toBe(1.25)
  })

  it("clamps adjustments to the supported range", () => {
    expect(adjustVoiceSpeed(0.25, -1)).toBe(0.25)
    expect(adjustVoiceSpeed(0.1, -1)).toBe(0.25)
    expect(adjustVoiceSpeed(0.1, 1)).toBe(0.5)
    expect(adjustVoiceSpeed(5, 1)).toBe(5)
    expect(adjustVoiceSpeed(5, -1)).toBe(4.75)
  })

  it("rounds loaded speeds to the nearest quarter and clamps extreme values", () => {
    expect(normalizeVoiceSpeed(1.1)).toBe(1)
    expect(normalizeVoiceSpeed(1.125)).toBe(1.25)
    expect(normalizeVoiceSpeed(1.2)).toBe(1.25)
    expect(normalizeVoiceSpeed(0.1)).toBe(0.25)
    expect(normalizeVoiceSpeed(20)).toBe(5)
    expect(normalizeVoiceSpeed(Number.MAX_VALUE)).toBe(5)
  })

  it("formats every quarter step without floating-point artifacts", () => {
    expect(formatVoiceSpeed(25)).toBe("0.25")
    expect(formatVoiceSpeed(50)).toBe("0.5")
    expect(formatVoiceSpeed(75)).toBe("0.75")
    expect(formatVoiceSpeed(100)).toBe("1")
    expect(formatVoiceSpeed(125)).toBe("1.25")
    expect(formatVoiceSpeed(450)).toBe("4.5")
    expect(formatVoiceSpeed(500)).toBe("5")
  })

  it("performs repeated reversible adjustments without drift", () => {
    const controller = createVoiceSpeedController(undefined, 1, speedStorage(1.1), () => {})
    expect(controller.percent).toBe(100)
    for (let count = 0; count < 100; count++) {
      controller.adjust(1)
      controller.adjust(-1)
    }
    expect(controller.percent).toBe(100)
    expect(controller.speed).toBe(1)
    for (let count = 0; count < 100; count++) controller.adjust(1)
    expect(controller.percent).toBe(500)
    for (let count = 0; count < 100; count++) controller.adjust(-1)
    expect(controller.percent).toBe(25)
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

  it("normalizes configured and previously saved decimal speeds on load", async () => {
    const storage = speedStorage(1.13)
    const saved = createVoiceSpeedController(undefined, 1, storage, () => {})
    expect(saved.speed).toBe(1.25)
    expect(saved.adjust(-1)).toBe(1)
    await saved.flush()
    expect(storage.state.speed).toBe(1)
    expect(createVoiceSpeedController(1.1, 1, storage, () => {}).speed).toBe(1)
    expect(createVoiceSpeedController(0.1, 1, storage, () => {}).speed).toBe(0.25)
    expect(createVoiceSpeedController(8, 1, storage, () => {}).speed).toBe(5)
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
