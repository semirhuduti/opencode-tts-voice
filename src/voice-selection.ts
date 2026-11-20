export type VoiceChoice = {
  id: string
  name: string
  accent: "American English" | "British English"
  gender: "Female" | "Male"
}

export const VOICE_CHOICES: VoiceChoice[] = [
  ...["heart", "alloy", "aoede", "bella", "jessica", "kore", "nicole", "nova", "river", "sarah", "sky"].map((name) => voiceChoice("af", name)),
  ...["adam", "echo", "eric", "fenrir", "liam", "michael", "onyx", "puck", "santa"].map((name) => voiceChoice("am", name)),
  ...["alice", "emma", "isabella", "lily"].map((name) => voiceChoice("bf", name)),
  ...["daniel", "fable", "george", "lewis"].map((name) => voiceChoice("bm", name)),
]

function voiceChoice(prefix: "af" | "am" | "bf" | "bm", name: string): VoiceChoice {
  return {
    id: `${prefix}_${name}`,
    name: name[0].toUpperCase() + name.slice(1),
    accent: prefix[0] === "a" ? "American English" : "British English",
    gender: prefix[1] === "f" ? "Female" : "Male",
  }
}

export function isSelectableVoice(value: unknown): value is string {
  return typeof value === "string" && VOICE_CHOICES.some((voice) => voice.id === value)
}

export function createVoiceSelectionController(
  configuredVoice: unknown,
  defaultVoice: string,
  storage: {
    store(key: string, options: { initial: { voice: string | null } }): readonly [
      { readonly voice: string | null },
      (mutation: (draft: { voice: string | null }) => void) => Promise<void>,
    ]
  },
  onSaveError: (error: unknown) => void,
) {
  const [saved, update] = storage.store("voice", { initial: { voice: null } })
  const configured = typeof configuredVoice === "string" && configuredVoice.trim().length > 0
  let current = configured ? configuredVoice.trim() : isSelectableVoice(saved.voice) ? saved.voice : defaultVoice
  let pending = Promise.resolve()

  return {
    get voice() { return current },
    select(voice: string) {
      if (!isSelectableVoice(voice)) return false
      current = voice
      if (!configured) {
        pending = pending.then(() => update((draft) => { draft.voice = voice })).catch(onSaveError)
      }
      return true
    },
    flush() { return pending },
  }
}
