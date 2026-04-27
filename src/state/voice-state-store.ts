import { KV_ENABLED } from "../voice-constants.js"
import { createLogger } from "../voice-log.js"
import type { VoiceConfig, VoiceState } from "../voice-types.js"
import type { TimerRegistry } from "../shared/timer-registry.js"

export type VoiceStateListener = () => void

const LISTENER_NOTIFY_DELAY_MS = 50

export class VoiceStateStore {
  private readonly log = createLogger("state")
  private readonly listeners = new Set<VoiceStateListener>()
  private listenerTimer?: NodeJS.Timeout
  private disposed = false
  private state: VoiceState

  constructor(
    private readonly kv: { get<T>(key: string, fallback: T): T; set<T>(key: string, value: T): void },
    config: VoiceConfig,
    private readonly timers: TimerRegistry,
  ) {
    this.state = {
      enabled: kv.get(KV_ENABLED, true),
      paused: false,
      busy: false,
      generating: false,
      playing: false,
      backend: config.audioPlayer,
      device: config.device,
      error: undefined,
    }
  }

  subscribe(listener: VoiceStateListener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot() {
    return { ...this.state }
  }

  setEnabled(enabled: boolean) {
    this.kv.set(KV_ENABLED, enabled)
    this.patch({ enabled })
  }

  patch(patch: Partial<VoiceState>) {
    let changed = false
    const changedFields: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch) as Array<[keyof VoiceState, VoiceState[keyof VoiceState]]>) {
      if (this.state[key] === value) continue
      ;(this.state[key] as VoiceState[keyof VoiceState]) = value
      changedFields[key] = value
      changed = true
    }
    if (!changed) return
    this.log.debug("state changed", changedFields)
    this.scheduleListenerNotify()
  }

  notifyNow() {
    this.scheduleListenerNotify(true)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.timers.clear(this.listenerTimer)
    this.listenerTimer = undefined
    this.listeners.clear()
  }

  private scheduleListenerNotify(immediate = false) {
    if (this.disposed && !immediate) return

    if (this.listenerTimer) {
      if (!immediate) return
      this.timers.clear(this.listenerTimer)
      this.listenerTimer = undefined
    }

    if (immediate) {
      for (const listener of this.listeners) listener()
      return
    }

    this.listenerTimer = this.timers.setTimeout(() => {
      this.listenerTimer = undefined
      for (const listener of this.listeners) listener()
    }, LISTENER_NOTIFY_DELAY_MS)
  }
}
