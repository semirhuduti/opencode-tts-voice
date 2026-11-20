import type { VoiceState } from "../voice-types.js"

export function voiceStatusLabel(state: Pick<VoiceState, "enabled" | "device" | "error">) {
  if (state.error) return "! sound error"
  if (!state.enabled) return "sound off"
  if (state.device === "loading") return "sound initializing"
  return "sound on"
}
