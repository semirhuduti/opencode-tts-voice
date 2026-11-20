import type { Context } from "@opencode/plugin/tui/context"
import { createLogger } from "../voice-log.js"
import type { VoiceConfig } from "../voice-types.js"
import type { PlaybackPipeline } from "../playback/playback-pipeline.js"
import type { SessionStore } from "../session/session-store.js"
import type { VoiceStateStore } from "../state/voice-state-store.js"
import { formatError } from "../shared/voice-utils.js"
import { StreamBuffer, type StreamBlock } from "./stream-buffer.js"

type StreamEvent = {
  sessionID: string
  assistantMessageID: string
  ordinal: number
}

// V2 identifies a stream by its assistant message, content ordinal and block type.
export function streamKey(event: StreamEvent, block: StreamBlock) {
  return JSON.stringify([event.sessionID, event.assistantMessageID, block, event.ordinal])
}

export class StreamingController {
  private readonly log = createLogger("streaming")
  private readonly streams = new Map<string, StreamBuffer>()
  private readonly tasks = new Map<string, Promise<void>>()
  private readonly cleanup: Array<() => void> = []
  private disposed = false

  constructor(
    private readonly api: Context,
    private readonly config: VoiceConfig,
    private readonly state: VoiceStateStore,
    private readonly playback: PlaybackPipeline,
    private readonly sessionStore: SessionStore,
  ) {
    this.cleanup.push(
      api.data.on("session.text.delta", (event) => this.queue(event.data, "message", () => this.delta(event.data, "message"))),
      api.data.on("session.text.ended", (event) => this.queue(event.data, "message", () => this.end(event.data, "message"))),
      api.data.on("session.reasoning.delta", (event) => this.queue(event.data, "reason", () => this.delta(event.data, "reason"))),
      api.data.on("session.reasoning.ended", (event) => this.queue(event.data, "reason", () => this.end(event.data, "reason"))),
      api.data.on("session.execution.interrupted", (event) => this.clearSession(event.data.sessionID)),
      api.data.on("session.execution.failed", (event) => this.clearSession(event.data.sessionID)),
      sessionStore.onDeleted((sessionID) => {
        this.clearSession(sessionID)
      }),
    )
  }

  private clearSession(sessionID: string) {
    for (const [key, stream] of this.streams) {
      if (stream.sessionID === sessionID) this.streams.delete(key)
    }
  }

  dispose() {
    this.disposed = true
    for (const off of this.cleanup) off()
    this.cleanup.length = 0
    this.streams.clear()
  }

  private queue(event: StreamEvent, block: StreamBlock, task: () => Promise<void>) {
    const key = streamKey(event, block)
    const previous = this.tasks.get(key) ?? Promise.resolve()
    const next = previous.then(task).catch((error) => this.log.warn("stream event failed", { error: formatError(error) }))
    this.tasks.set(key, next)
    void next.finally(() => {
      if (this.tasks.get(key) === next) this.tasks.delete(key)
    })
  }

  private async canSpeak(event: StreamEvent, block: StreamBlock) {
    if (this.disposed || !this.config.speakResponses || !this.config.speechBlocks.includes(block)) return false
    if (!this.state.snapshot().enabled) return false
    const route = this.api.ui.router.current()
    if (route.type !== "session") return false
    const parentID = await this.sessionStore.sessionParentID(event.sessionID)
    const current = this.api.ui.router.current()
    const visible = current.type === "session" && current.sessionID === route.sessionID
    const allowed = parentID
      ? this.config.speakSubagentResponses && parentID === route.sessionID
      : event.sessionID === route.sessionID
    return !this.disposed && visible && allowed && this.state.snapshot().enabled
  }

  private async keepUp(event: StreamEvent, block: StreamBlock) {
    const key = streamKey(event, block)
    const previous = this.streams.get(key)
    if (previous?.completed) return undefined
    const stream = previous ?? new StreamBuffer(event.sessionID, event.assistantMessageID, block)
    this.streams.set(key, stream)
    while (this.streams.size > 200) {
      const removable = [...this.streams].find(([candidate, item]) => candidate !== key && (item.completed || item.sessionID !== event.sessionID))
      if (!removable) break
      this.streams.delete(removable[0])
    }
    return { stream, previous, speak: await this.canSpeak(event, block) }
  }

  private async delta(event: StreamEvent & { delta: string }, block: StreamBlock) {
    const current = await this.keepUp(event, block)
    if (!current || this.disposed) return
    const { stream, previous, speak } = current
    const result = stream.applyDelta(event.delta, block, this.config, !previous)
    if (!speak || !this.state.snapshot().enabled) {
      stream.buffer = ""
      return
    }
    for (const chunk of result.chunks) {
      this.playback.enqueuePreparedChunk(chunk.text, chunk.pauseMs, "stream", {
        origin: "session.stream.delta",
        sessionID: event.sessionID,
        messageID: event.assistantMessageID,
        block,
      })
    }
  }

  private async end(event: StreamEvent & { text: string }, block: StreamBlock) {
    const current = await this.keepUp(event, block)
    if (!current || this.disposed) return
    const { stream, previous, speak } = current
    const result = stream.applyFinal(event.text, block, this.config, !previous)
    for (const chunk of speak && this.state.snapshot().enabled ? result.chunks : []) {
      this.playback.enqueuePreparedChunk(chunk.text, chunk.pauseMs, "stream", {
        origin: "session.stream.ended",
        sessionID: event.sessionID,
        messageID: event.assistantMessageID,
        block,
      })
    }
  }
}
