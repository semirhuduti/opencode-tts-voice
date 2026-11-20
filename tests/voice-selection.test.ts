import { describe, expect, it } from "bun:test"
import { createVoiceSelectionController, isSelectableVoice, VOICE_CHOICES } from "../src/voice-selection.js"

function storage(initial: string | null = null) {
  const state = { voice: initial }
  return {
    state,
    store(_key: string, _options: { initial: { voice: string | null } }) {
      return [state, async (mutation: (draft: { voice: string | null }) => void) => mutation(state)] as const
    },
  }
}

describe("voice selection", () => {
  it("lists 28 selectable English voices", () => {
    expect(VOICE_CHOICES).toHaveLength(28)
    expect(new Set(VOICE_CHOICES.map((voice) => voice.id)).size).toBe(28)
    expect(isSelectableVoice("bf_emma")).toBe(true)
    expect(isSelectableVoice("jf_alpha")).toBe(false)
  })

  it("saves selections and restores them on the next load", async () => {
    const store = storage()
    const first = createVoiceSelectionController(undefined, "af_heart", store, () => {})
    expect(first.voice).toBe("af_heart")
    expect(first.select("bf_emma")).toBe(true)
    expect(first.select("invalid")).toBe(false)
    await first.flush()
    expect(store.state.voice).toBe("bf_emma")
    expect(createVoiceSelectionController(undefined, "af_heart", store, () => {}).voice).toBe("bf_emma")
  })

  it("uses an explicitly configured voice without replacing the saved selection", async () => {
    const store = storage("am_puck")
    const first = createVoiceSelectionController("  af_bella  ", "af_bella", store, () => {})
    expect(first.voice).toBe("af_bella")
    first.select("bf_emma")
    await first.flush()
    expect(store.state.voice).toBe("am_puck")
    expect(createVoiceSelectionController("af_bella", "af_bella", store, () => {}).voice).toBe("af_bella")
    expect(createVoiceSelectionController(undefined, "af_heart", store, () => {}).voice).toBe("am_puck")
  })

  it("ignores invalid stored values but preserves configured custom IDs", () => {
    const store = storage("invalid")
    expect(createVoiceSelectionController(undefined, "af_heart", store, () => {}).voice).toBe("af_heart")
    expect(createVoiceSelectionController("custom", "custom", store, () => {}).voice).toBe("custom")
  })

  it("reports failed writes and continues with later selections", async () => {
    const state = { voice: null as string | null }
    const errors: unknown[] = []
    let attempts = 0
    const store = {
      store() {
        return [state, async (mutation: (draft: typeof state) => void) => {
          if (++attempts === 1) throw new Error("storage unavailable")
          mutation(state)
        }] as const
      },
    }
    const controller = createVoiceSelectionController(undefined, "af_heart", store, (error) => errors.push(error))
    controller.select("af_bella")
    controller.select("bf_emma")
    await controller.flush()
    expect(errors).toHaveLength(1)
    expect(state.voice).toBe("bf_emma")
  })
})
