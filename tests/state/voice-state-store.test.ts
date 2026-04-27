import { describe, expect, it } from "bun:test"
import { DEFAULT_CONFIG, KV_ENABLED } from "../../src/voice-constants.js"
import { TimerRegistry } from "../../src/shared/timer-registry.js"
import { VoiceStateStore } from "../../src/state/voice-state-store.js"

class MemoryKv {
  readonly values = new Map<string, unknown>()

  get<T>(key: string, fallback: T): T {
    return this.values.has(key) ? (this.values.get(key) as T) : fallback
  }

  set<T>(key: string, value: T) {
    this.values.set(key, value)
  }
}

describe("VoiceStateStore", () => {
  it("returns snapshots and notifies subscribers", async () => {
    const timers = new TimerRegistry()
    const kv = new MemoryKv()
    const store = new VoiceStateStore(kv, DEFAULT_CONFIG, timers)
    let count = 0
    store.subscribe(() => {
      count += 1
    })

    store.patch({ paused: true })
    await timers.sleep(60)

    expect(count).toBe(1)
    expect(store.snapshot().paused).toBe(true)
    expect(store.snapshot()).not.toBe(store.snapshot())
    store.dispose()
    timers.dispose()
  })

  it("persists enabled state and clears timers on disposal", () => {
    const timers = new TimerRegistry()
    const kv = new MemoryKv()
    const store = new VoiceStateStore(kv, DEFAULT_CONFIG, timers)

    store.subscribe(() => undefined)
    store.setEnabled(false)
    store.patch({ paused: true })
    expect(kv.values.get(KV_ENABLED)).toBe(false)
    expect(timers.snapshot().size).toBeGreaterThan(0)

    store.dispose()
    expect(timers.snapshot().size).toBe(0)
    timers.dispose()
  })
})
