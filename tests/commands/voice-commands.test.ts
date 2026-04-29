import { describe, expect, it } from "bun:test"
import type { QueueTrace } from "../../src/playback/queue.js"
import { VoiceCommands } from "../../src/commands/voice-commands.js"
import { DEFAULT_CONFIG } from "../../src/voice-constants.js"
import type { AssistantHistoryEntry } from "../../src/latest/latest-message-store.js"
import type { VoiceConfig, VoiceState } from "../../src/voice-types.js"

type EnqueuedChunk = {
  text: string
  pauseMs: number
  source: string
  trace?: QueueTrace
}

type Toast = {
  variant: "info" | "success" | "warning" | "error"
  message: string
}

function historyEntry(messageID: string, text: string, chronologicalIndex: number): AssistantHistoryEntry {
  return {
    sessionID: "session-1",
    messageID,
    created: chronologicalIndex,
    text,
    preview: text,
    chronologicalIndex,
  }
}

function createHarness(options: {
  config?: Partial<VoiceConfig>
  state?: Partial<VoiceState>
  continuation?: AssistantHistoryEntry[]
  latestText?: string
} = {}) {
  let enabled = options.state?.enabled ?? true
  let paused = options.state?.paused ?? false
  const enqueued: EnqueuedChunk[] = []
  const resets: boolean[] = []
  const toasts: Toast[] = []
  const config = { ...DEFAULT_CONFIG, ...options.config }
  const route = { current: { name: "session", params: { sessionID: "session-1" } } }
  const state = {
    snapshot: () => ({
      enabled,
      paused,
      busy: false,
      generating: false,
      playing: false,
      backend: "auto",
      device: "auto",
      error: undefined,
      ...options.state,
      enabled,
      paused,
    }),
    setEnabled(next: boolean) {
      enabled = next
    },
    patch(patch: Partial<VoiceState>) {
      if (typeof patch.paused === "boolean") paused = patch.paused
    },
    notifyNow() {},
  }
  const playback = {
    async reset(requeueCurrent: boolean) {
      resets.push(requeueCurrent)
    },
    enqueuePreparedChunk(text: string, pauseMs: number, source: string, trace?: QueueTrace) {
      enqueued.push({ text, pauseMs, source, trace })
      return 1
    },
    isBusy: () => enqueued.length > 0,
    pause() {},
    resume() {},
  }
  const latestStore = {
    collectDisplayHistory: async () => options.continuation ?? [],
    hasPlayableHistory: async () => Boolean(options.continuation?.length),
    collectContinuationHistory: async () => options.continuation ?? [],
    replayText: () => ({ text: options.latestText, source: "state" as const }),
  }
  const sessionStore = {
    shouldSpeakSession: async () => true,
  }
  const commands = new VoiceCommands(
    route as never,
    config,
    state as never,
    playback as never,
    sessionStore as never,
    latestStore as never,
    (toast) => toasts.push(toast),
  )

  return { commands, enqueued, resets, toasts, get enabled() { return enabled } }
}

describe("VoiceCommands history playback", () => {
  it("auto-enables speech and resets playback before queueing history", async () => {
    const harness = createHarness({
      state: { enabled: false },
      continuation: [historyEntry("message-1", "History message.", 0)],
    })

    expect(await harness.commands.playHistory("message-1", "single")).toBe(true)

    expect(harness.enabled).toBe(true)
    expect(harness.resets).toEqual([false])
    expect(harness.enqueued).toHaveLength(1)
    expect(harness.enqueued[0]?.source).toBe("history")
    expect(harness.toasts).toEqual([])
  })

  it("queues only the selected message for single-message history playback", async () => {
    const harness = createHarness({
      continuation: [historyEntry("message-1", "First.", 0), historyEntry("message-2", "Second.", 1)],
    })

    await harness.commands.playHistory("message-1", "single")

    expect(harness.enqueued.map((item) => item.text)).toEqual(["First."])
    expect(harness.enqueued[0]?.trace).toMatchObject({
      origin: "historyPlayback",
      sessionID: "session-1",
      messageID: "message-1",
      replayMode: "single",
      messageIndex: 0,
      chunkIndex: 0,
    })
  })

  it("queues the selected message and later messages for continuation playback", async () => {
    const harness = createHarness({
      continuation: [historyEntry("message-2", "Second.", 1), historyEntry("message-3", "Third.", 2)],
    })

    await harness.commands.playHistory("message-2", "continue")

    expect(harness.enqueued.map((item) => item.text)).toEqual(["Second.", "Third."])
    expect(harness.enqueued.map((item) => item.trace?.replayMode)).toEqual(["continue", "continue"])
    expect(harness.enqueued.map((item) => item.trace?.messageID)).toEqual(["message-2", "message-3"])
  })

  it("preserves replay-latest success toast behavior", async () => {
    const harness = createHarness({ latestText: "Latest message." })

    expect(await harness.commands.replayLatest()).toBe(true)

    expect(harness.enqueued[0]?.source).toBe("latest")
    expect(harness.toasts).toContainEqual({ variant: "info", message: "Replaying latest assistant message" })
  })
})
