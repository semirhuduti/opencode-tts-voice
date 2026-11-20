export const MIN_VOICE_SPEED = 0.25
export const MAX_VOICE_SPEED = 5
export const VOICE_SPEED_STEP = 0.25

const MIN_SPEED_PERCENT = 25
const MAX_SPEED_PERCENT = 500
const SPEED_STEP_PERCENT = 25

export function isValidVoiceSpeed(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

function speedToPercent(speed: number) {
  const clamped = Math.max(MIN_VOICE_SPEED, Math.min(MAX_VOICE_SPEED, speed))
  return Math.round(clamped / VOICE_SPEED_STEP) * SPEED_STEP_PERCENT
}

function adjustSpeedPercent(percent: number, direction: -1 | 1) {
  return Math.max(MIN_SPEED_PERCENT, Math.min(MAX_SPEED_PERCENT, percent + direction * SPEED_STEP_PERCENT))
}

export function normalizeVoiceSpeed(speed: number) {
  return speedToPercent(speed) / 100
}

export function formatVoiceSpeed(percent: number) {
  const whole = Math.floor(percent / 100)
  const fraction = percent % 100
  if (fraction === 0) return String(whole)
  return `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`
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
  let current = speedToPercent(configured ? configuredSpeed : isValidVoiceSpeed(saved.speed) ? saved.speed : defaultSpeed)
  let pending = Promise.resolve()

  return {
    get speed() { return current / 100 },
    get percent() { return current },
    adjust(direction: -1 | 1) {
      current = adjustSpeedPercent(current, direction)
      if (!configured) {
        const next = current / 100
        pending = pending.then(() => update((draft) => { draft.speed = next })).catch(onSaveError)
      }
      return current / 100
    },
    flush() { return pending },
  }
}

export function adjustVoiceSpeed(speed: number, direction: -1 | 1) {
  const current = speedToPercent(speed)
  return adjustSpeedPercent(current, direction) / 100
}

export function scalePauseForSpeed(pauseMs: number, speed: number) {
  return Math.round(pauseMs / speed)
}
