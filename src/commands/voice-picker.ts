import type { Context, DialogSelectOption } from "@opencode/plugin/tui/context"
import { VOICE_CHOICES } from "../voice-selection.js"

export async function openVoicePicker(
  api: Pick<Context, "ui">,
  current: string,
  preview: (voice: string) => void,
  select: (voice: string) => void,
  isDisposed: () => boolean,
) {
  const options: DialogSelectOption<string>[] = VOICE_CHOICES.map((voice) => ({
    title: `${voice.name} — ${voice.gender}${voice.id === current ? " · Current" : ""}`,
    description: voice.id,
    category: voice.accent,
    value: voice.id,
  }))
  const selected = await api.ui.dialog.select({
    title: "Choose voice",
    placeholder: "Search voices",
    current,
    options,
    search: (query, choices) => {
      const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
      return choices.filter((choice) => {
        const voice = VOICE_CHOICES.find((entry) => entry.id === choice.value)
        const searchable = `${choice.title} ${choice.description ?? ""} ${choice.category ?? ""}`.toLowerCase()
        return terms.every((term) => {
          if (term === "male" || term === "female") return voice?.gender.toLowerCase() === term
          return searchable.includes(term)
        })
      })
    },
    actions: [{
      bind: "ctrl+o",
      title: "Preview",
      onTrigger: (voice) => { if (!isDisposed()) preview(voice) },
    }],
  })
  if (!isDisposed() && selected) select(selected)
}
