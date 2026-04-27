import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Part } from "@opencode-ai/sdk/v2"
import { createLogger } from "../voice-log.js"
import type { VoiceBlock, VoiceConfig } from "../voice-types.js"
import type { LatestMessageStore } from "../latest/latest-message-store.js"
import type { MessageStore } from "../messages/message-store.js"
import type { PlaybackPipeline } from "../playback/playback-pipeline.js"
import type { SessionStore } from "../session/session-store.js"
import type { VoiceStateStore } from "../state/voice-state-store.js"
import { formatError, textFingerprint, textPreview } from "../shared/voice-utils.js"
import { StreamBuffer, type StreamBlock } from "./stream-buffer.js"

const MAX_COMPLETED_STREAMS = 200

export class StreamingController {
  private readonly log = createLogger("streaming")
  private readonly streams = new Map<string, StreamBuffer>()
  private readonly partTasks = new Map<string, Promise<void>>()
  private readonly cleanup: Array<() => void> = []
  private eventSeq = 0
  private disposed = false

  constructor(
    private readonly api: TuiPluginApi,
    private readonly config: VoiceConfig,
    private readonly state: VoiceStateStore,
    private readonly playback: PlaybackPipeline,
    private readonly sessionStore: SessionStore,
    private readonly messageStore: MessageStore,
    private readonly latestStore: LatestMessageStore,
  ) {
    this.cleanup.push(
      api.event.on("message.part.delta", (event) =>
        this.runPartEventTask(event.properties.partID, "message.part.delta", () => this.onMessagePartDelta(event.properties)),
      ),
      api.event.on("message.part.updated", (event) =>
        this.runPartEventTask(event.properties.part.id, "message.part.updated", () => this.onMessagePartUpdated(event.properties.part)),
      ),
      this.sessionStore.onDeleted((sessionID) => this.clearSession(sessionID)),
    )
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.cleanup) off()
    this.cleanup.length = 0
    this.streams.clear()
  }

  private runPartEventTask(partID: string, eventName: string, task: () => Promise<void>) {
    const previous = this.partTasks.get(partID) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        this.log.warn("event handler failed", { eventName, partID, error: formatError(error) })
      })

    this.partTasks.set(partID, next)
    void next.finally(() => {
      if (this.partTasks.get(partID) === next) this.partTasks.delete(partID)
    })
  }

  private clearSession(sessionID: string) {
    for (const [partID, stream] of this.streams) {
      if (stream.sessionID === sessionID) this.streams.delete(partID)
    }
  }

  private isVoiceBlockEnabled(block: VoiceBlock) {
    return this.config.speechBlocks.includes(block)
  }

  private blockForPart(part: Part): StreamBlock | undefined {
    if (part.type === "reasoning") return "reason"
    if (part.type === "text" && !part.synthetic && !part.ignored) return "message"
    return undefined
  }

  private blockForDelta(event: { messageID: string; partID: string; field: string }) {
    if (event.field === "reasoning_content" || event.field === "reasoning_details") return "reason" as const
    if (event.field !== "text") return undefined

    const buffered = this.streams.get(event.partID)
    if (buffered) return buffered.block

    const part = this.lookupPart(event.messageID, event.partID)
    return part ? this.blockForPart(part) : "message"
  }

  private lookupPart(messageID: string, partID: string) {
    return this.api.state.part(messageID).find((part) => part.id === partID)
  }

  private async onMessagePartDelta(event: { sessionID: string; messageID: string; partID: string; field: string; delta: string }) {
    const eventSeq = this.eventSeq++
    if (!this.config.speakResponses) return
    if (!(await this.sessionStore.shouldSpeakSession(event.sessionID))) {
      this.log.debug("stream delta skipped for session", {
        eventSeq,
        sessionID: event.sessionID,
        messageID: event.messageID,
        partID: event.partID,
        field: event.field,
      })
      this.streams.delete(event.partID)
      return
    }

    const block = this.blockForDelta(event)
    if (!block || !this.isVoiceBlockEnabled(block)) {
      this.log.debug("stream delta skipped for block", {
        eventSeq,
        sessionID: event.sessionID,
        messageID: event.messageID,
        partID: event.partID,
        field: event.field,
        block,
      })
      return
    }

    const message = this.messageStore.lookupMessage(event.sessionID, event.messageID)
    const state = this.state.snapshot()
    if (!message || message.role !== "assistant" || message.summary || !state.enabled) {
      this.log.warn("stream delta ignored", {
        eventSeq,
        sessionID: event.sessionID,
        messageID: event.messageID,
        partID: event.partID,
        hasMessage: Boolean(message),
        role: message?.role,
        summary: Boolean(message?.summary),
        enabled: state.enabled,
      })
      return
    }

    const existing = this.streams.get(event.partID)
    if (existing?.completed) {
      this.log.warn("stream delta ignored after completion", {
        eventSeq,
        sessionID: event.sessionID,
        messageID: event.messageID,
        partID: event.partID,
        field: event.field,
        deltaLength: event.delta.length,
        streamTextLength: existing.textLength,
        preview: textPreview(event.delta),
      })
      return
    }

    const stream = existing ?? new StreamBuffer(event.sessionID, event.messageID, block)
    const result = stream.applyDelta(event.delta, block, this.config, !existing)
    this.log.debug("stream delta accepted", {
      eventSeq,
      sessionID: event.sessionID,
      messageID: event.messageID,
      partID: event.partID,
      block,
      field: event.field,
      deltaLength: event.delta.length,
      startOffset: result.startOffset,
      endOffset: result.endOffset,
      bufferLength: stream.buffer.length,
      deltaFingerprint: textFingerprint(event.delta),
      preview: textPreview(event.delta),
      newStream: result.newStream,
    })

    if (result.chunks.length > 0) {
      this.log.info("stream chunks drained", {
        eventSeq,
        sessionID: event.sessionID,
        messageID: event.messageID,
        partID: event.partID,
        block,
        field: event.field,
        startOffset: result.startOffset,
        endOffset: result.endOffset,
        chunkCount: result.chunks.length,
        restLength: result.rest.length,
      })
    }
    result.chunks.forEach((chunk, index) => {
      this.playback.enqueuePreparedChunk(chunk.text, chunk.pauseMs, "stream", {
        origin: "message.part.delta",
        eventSeq,
        sessionID: event.sessionID,
        messageID: event.messageID,
        partID: event.partID,
        block,
        field: event.field,
        startOffset: result.startOffset,
        endOffset: result.endOffset,
        deltaLength: event.delta.length,
        chunkIndex: index,
        chunkCount: result.chunks.length,
        restLength: result.rest.length,
      })
    })

    this.streams.set(event.partID, stream)
  }

  private async onMessagePartUpdated(part: Part) {
    const eventSeq = this.eventSeq++
    if (part.type !== "text" && part.type !== "reasoning") return
    if (!(await this.sessionStore.shouldSpeakSession(part.sessionID))) {
      this.log.debug("part update skipped for session", {
        eventSeq,
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
        type: part.type,
      })
      this.streams.delete(part.id)
      return
    }

    const block = this.blockForPart(part)
    if (!block) {
      this.log.debug("part update skipped for block", {
        eventSeq,
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
        type: part.type,
      })
      return
    }

    const message = this.messageStore.lookupMessage(part.sessionID, part.messageID)
    if (!message || message.role !== "assistant" || message.summary) {
      this.log.warn("part update ignored", {
        eventSeq,
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
        hasMessage: Boolean(message),
        role: message?.role,
        summary: Boolean(message?.summary),
      })
      return
    }

    const text = typeof part.text === "string" ? part.text : ""
    const existing = this.streams.get(part.id)
    if (existing?.completed) {
      this.log.warn("part update ignored after completion", {
        eventSeq,
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
        block,
        textLength: text.length,
        streamTextLength: existing.textLength,
        ended: Boolean(part.time?.end),
        fingerprint: textFingerprint(text),
        preview: textPreview(text),
      })
      return
    }

    const stream = existing ?? new StreamBuffer(part.sessionID, part.messageID, block)
    const finalFlush = Boolean(part.time?.end)

    if (!finalFlush) {
      stream.storeSnapshot(block)
      this.log.debug("part update snapshot stored", {
        eventSeq,
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
        block,
        previousTextLength: stream.rawText.length,
        textLength: text.length,
        fingerprint: textFingerprint(text),
        preview: textPreview(text),
        newStream: !existing,
      })
      this.streams.set(part.id, stream)
      return
    }

    const previousTextLength = stream.rawText.length
    const result = stream.applyFinal(text, block, this.config, !existing)
    if (result.cursorReset) {
      this.log.warn("part final update diverged", {
        eventSeq,
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
        block,
        previousTextLength,
        textLength: text.length,
        ended: Boolean(part.time?.end),
        fingerprint: textFingerprint(text),
        preview: textPreview(text),
      })
    }
    this.log.debug("part update accepted", {
      eventSeq,
      sessionID: part.sessionID,
      messageID: part.messageID,
      partID: part.id,
      block,
      startOffset: result.startOffset,
      endOffset: result.endOffset,
      textLength: text.length,
      nextTextLength: result.nextText.length,
      bufferLength: stream.buffer.length,
      finalFlush,
      cursorReset: result.cursorReset,
      nextFingerprint: textFingerprint(result.nextText),
      preview: textPreview(result.nextText),
      newStream: result.newStream,
    })

    const state = this.state.snapshot()
    if (state.enabled && this.config.speakResponses && this.isVoiceBlockEnabled(block)) {
      if (result.chunks.length > 0 || part.time?.end) {
        this.log.info("part updated", {
          eventSeq,
          sessionID: part.sessionID,
          messageID: part.messageID,
          partID: part.id,
          block,
          startOffset: result.startOffset,
          endOffset: result.endOffset,
          textLength: text.length,
          nextTextLength: result.nextText.length,
          chunkCount: result.chunks.length,
          restLength: result.rest.length,
          ended: Boolean(part.time?.end),
          cursorReset: result.cursorReset,
        })
      }
      result.chunks.forEach((chunk, index) => {
        this.playback.enqueuePreparedChunk(chunk.text, chunk.pauseMs, "stream", {
          origin: "message.part.updated",
          eventSeq,
          sessionID: part.sessionID,
          messageID: part.messageID,
          partID: part.id,
          block,
          startOffset: result.startOffset,
          endOffset: result.endOffset,
          fullTextLength: text.length,
          nextTextLength: result.nextText.length,
          chunkIndex: index,
          chunkCount: result.chunks.length,
          restLength: result.rest.length,
          finalFlush,
          cursorReset: result.cursorReset,
        })
      })
    }

    this.log.info("part completed", {
      eventSeq,
      sessionID: part.sessionID,
      messageID: part.messageID,
      partID: part.id,
      block,
      finalTextLength: text.length,
      finalFingerprint: textFingerprint(text),
      preview: textPreview(text),
    })
    this.streams.set(part.id, stream)
    this.trimCompletedStreams()
    this.latestStore.scheduleLatestRefresh(part.sessionID, part.messageID)
  }

  private trimCompletedStreams() {
    let overflow = 0
    for (const stream of this.streams.values()) {
      if (stream.completed) overflow += 1
    }
    overflow -= MAX_COMPLETED_STREAMS
    if (overflow <= 0) return

    for (const [partID, stream] of this.streams) {
      if (!stream.completed) continue
      this.log.debug("completed stream trimmed", {
        partID,
        sessionID: stream.sessionID,
        messageID: stream.messageID,
        block: stream.block,
        textLength: stream.textLength,
      })
      this.streams.delete(partID)
      overflow -= 1
      if (overflow <= 0) return
    }
  }
}
