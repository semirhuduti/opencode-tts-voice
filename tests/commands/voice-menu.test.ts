import { describe, expect, it } from "bun:test"
import { openVoiceMenu } from "../../src/commands/voice-menu.js"

type Action = "history" | "pause" | "latest" | "toggle" | "slower" | "faster" | "choose"
type Menu = { title: string; options: Array<{ title: string; value: Action }> }

function createHarness(selected: Action | undefined, disposed = false) {
  let menu: Menu | undefined
  const invoked: Action[] = []
  const api = {
    keymap: {
      shortcuts: (id: string) => ({
        "tts.history": ["Ctrl+H"],
        "tts.play-pause": ["F6"],
        "tts.latest": ["F7"],
        "tts.toggle": ["F8"],
        "tts.slower": ["Ctrl+F6"],
        "tts.faster": ["Ctrl+F7"],
      })[id] ?? [],
    },
    ui: {
      dialog: {
        select: async (options: Menu) => {
          menu = options
          return selected
        },
      },
    },
  }
  const actions = {
    history: async () => { invoked.push("history") },
    pause: async () => { invoked.push("pause") },
    latest: async () => { invoked.push("latest") },
    toggle: async () => { invoked.push("toggle") },
    slower: async () => { invoked.push("slower") },
    faster: async () => { invoked.push("faster") },
    choose: async () => { invoked.push("choose") },
  }
  const run = () => openVoiceMenu(api as never, actions, () => disposed)
  return { run, invoked, get menu() { return menu } }
}

describe("voice shortcut menu", () => {
  it("lists all actions with their active shortcuts", async () => {
    const harness = createHarness(undefined)

    await harness.run()

    expect(harness.menu?.title).toBe("Voice shortcuts")
    expect(harness.menu?.options).toEqual([
      { title: "Choose voice  [unbound]", value: "choose" },
      { title: "Open assistant message history  [Ctrl+H]", value: "history" },
      { title: "Play or pause speech  [F6]", value: "pause" },
      { title: "Replay latest assistant message  [F7]", value: "latest" },
      { title: "Enable or disable speech  [F8]", value: "toggle" },
      { title: "Slow down speech  [Ctrl+F6]", value: "slower" },
      { title: "Speed up speech  [Ctrl+F7]", value: "faster" },
    ])
    expect(harness.invoked).toEqual([])
  })

  for (const action of ["history", "pause", "latest", "toggle", "slower", "faster", "choose"] as const) {
    it(`runs the selected ${action} action`, async () => {
      const harness = createHarness(action)
      await harness.run()
      expect(harness.invoked).toEqual([action])
    })
  }

  it("does nothing if the plugin was disposed while the menu was open", async () => {
    const harness = createHarness("toggle", true)
    await harness.run()
    expect(harness.invoked).toEqual([])
  })
})
