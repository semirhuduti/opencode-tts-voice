import type { Context } from "@opencode/plugin/tui/context"

type VoiceAction = "history" | "pause" | "latest" | "toggle"
type VoiceActionHandlers = Record<VoiceAction, () => Promise<void>>

export async function openVoiceMenu(
  api: Pick<Context, "keymap" | "ui">,
  actions: VoiceActionHandlers,
  isDisposed: () => boolean,
) {
  const entries: Array<{ value: VoiceAction; id: string; title: string }> = [
    { value: "history", id: "tts.history", title: "Open assistant message history" },
    { value: "pause", id: "tts.play-pause", title: "Play or pause speech" },
    { value: "latest", id: "tts.latest", title: "Replay latest assistant message" },
    { value: "toggle", id: "tts.toggle", title: "Enable or disable speech" },
  ]
  const selected = await api.ui.dialog.select({
    title: "Voice shortcuts",
    options: entries.map((entry) => {
      const keys = api.keymap.shortcuts(entry.id)
      const shortcut = keys.length ? keys.join(", ") : "unbound"
      return { title: `${entry.title}  [${shortcut}]`, value: entry.value }
    }),
  })
  if (isDisposed() || !selected) return
  await actions[selected]()
}
