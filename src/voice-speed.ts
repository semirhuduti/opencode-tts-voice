export const MIN_VOICE_SPEED = 0.1
export const VOICE_SPEED_STEP = 0.25

export function adjustVoiceSpeed(speed: number, direction: -1 | 1) {
  return Math.max(MIN_VOICE_SPEED, Math.round((speed + direction * VOICE_SPEED_STEP) * 1000) / 1000)
}
