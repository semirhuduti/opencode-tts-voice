export const MIN_VOICE_SPEED = 0.1
export const VOICE_SPEED_STEP = 0.25

export function isValidVoiceSpeed(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_VOICE_SPEED
}

export function createVoiceSpeedController(
  configuredSpeed: unknown,
  defaultSpeed: number,
  storage: {
    store(key: string, options: { initial: { speed: number | null } }): readonly [
      { readonly speed: number | null },
      (mutation: (draft: { speed: number | null }) => void) => Promise<void>,
    ]
  },
  onSaveError: (error: unknown) => void,
) {
  const [saved, update] = storage.store("speed", { initial: { speed: null } })
  const configured = isValidVoiceSpeed(configuredSpeed)
  let current = configured ? configuredSpeed : isValidVoiceSpeed(saved.speed) ? saved.speed : defaultSpeed
  let pending = Promise.resolve()

  return {
    get speed() { return current },
    adjust(direction: -1 | 1) {
      current = adjustVoiceSpeed(current, direction)
      if (!configured) {
        const next = current
        pending = pending.then(() => update((draft) => { draft.speed = next })).catch(onSaveError)
      }
      return current
    },
    flush() { return pending },
  }
}

export function adjustVoiceSpeed(speed: number, direction: -1 | 1) {
  return Math.max(MIN_VOICE_SPEED, Math.round((speed + direction * VOICE_SPEED_STEP) * 1000) / 1000)
}

export function scalePauseForSpeed(pauseMs: number, speed: number) {
  return Math.round(pauseMs / speed)
}
