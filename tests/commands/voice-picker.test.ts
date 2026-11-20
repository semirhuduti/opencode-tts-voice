import { describe, expect, it } from "bun:test"
import type { DialogSelectOptions } from "@opencode/plugin/tui/context"
import { openVoicePicker } from "../../src/commands/voice-picker.js"

describe("voice picker", () => {
  it("groups, searches, previews, and selects voices", async () => {
    let dialog: DialogSelectOptions<string> | undefined
    const previews: string[] = []
    const selected: string[] = []
    const api = {
      ui: {
        dialog: {
          select: async (options: DialogSelectOptions<string>) => {
            dialog = options
            options.actions?.[0].onTrigger("bf_emma")
            return "am_puck"
          },
        },
      },
    }
    await openVoicePicker(api as never, "af_heart", (voice) => previews.push(voice), (voice) => selected.push(voice), () => false)
    expect(dialog?.current).toBe("af_heart")
    expect(dialog?.options).toHaveLength(28)
    expect(dialog?.options.find((option) => option.value === "af_heart")?.title).toContain("Current")
    expect(dialog?.actions?.[0].bind).toBe("ctrl+o")
    expect(dialog?.search?.("british female emma", dialog.options).map((option) => option.value)).toEqual(["bf_emma"])
    expect(dialog?.search?.("male", dialog.options)).toHaveLength(13)
    expect(dialog?.search?.("female", dialog.options)).toHaveLength(15)
    expect(dialog?.search?.("british male", dialog.options).map((option) => option.value)).toEqual([
      "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
    ])
    expect(dialog?.search?.("FEMALE british", dialog.options).map((option) => option.value)).toEqual([
      "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    ])
    expect(dialog?.search?.("em", dialog.options).map((option) => option.value)).toContain("bf_emma")
    expect(dialog?.search?.("am_puck", dialog.options).map((option) => option.value)).toEqual(["am_puck"])
    expect(previews).toEqual(["bf_emma"])
    expect(selected).toEqual(["am_puck"])
  })

  it("does not preview or select after disposal", async () => {
    const previews: string[] = []
    const selected: string[] = []
    const api = {
      ui: { dialog: { select: async (options: DialogSelectOptions<string>) => {
        options.actions?.[0].onTrigger("bf_emma")
        return "bf_emma"
      } } },
    }
    await openVoicePicker(api as never, "af_heart", (voice) => previews.push(voice), (voice) => selected.push(voice), () => true)
    expect(previews).toEqual([])
    expect(selected).toEqual([])
  })
})
