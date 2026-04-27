import type { SpeechSource, VoiceBlock } from "../voice-types.js"
import { textFingerprint, textPreview } from "../shared/voice-utils.js"

export type QueueTrace = {
  origin: string
  eventSeq?: number
  sessionID?: string
  messageID?: string
  partID?: string
  block?: Extract<VoiceBlock, "reason" | "message">
  field?: string
  startOffset?: number
  endOffset?: number
  fullTextLength?: number
  deltaLength?: number
  nextTextLength?: number
  chunkIndex?: number
  chunkCount?: number
  restLength?: number
  finalFlush?: boolean
  cursorReset?: boolean
  replaySource?: "cache" | "state"
}

export type QueueItem = {
  id: number
  epoch: number
  text: string
  pauseMs: number
  source: SpeechSource
  trace?: QueueTrace
}

export type GeneratedAudio = {
  text: string
  file: string
}

export type ReadyAudioItem =
  | {
      id: number
      epoch: number
      sourceItem: QueueItem
      kind: "audio"
      text: string
      file: string
    }
  | {
      id: number
      epoch: number
      sourceItem: QueueItem
      kind: "pause"
      durationMs: number
    }

type RecentChunkTrace = {
  queuedAt: number
  itemID: number
  source: SpeechSource
  epoch: number
  trace?: QueueTrace
  preview: string
}

export type PlaybackQueueEvent =
  | { type: "enqueued"; item: QueueItem; fingerprint: string; duplicate?: RecentChunkTrace }
  | { type: "coalesced"; item: QueueItem; fingerprint: string; addedFingerprint: string; addedTrace?: QueueTrace }
  | { type: "stream-trimmed"; queueLength: number; maxQueueLength: number }

const STREAM_COALESCE_QUEUE_THRESHOLD = 4
const MAX_STREAM_QUEUE_ITEMS = 32
const RECENT_CHUNK_TRACE_LIMIT = 200
const RECENT_CHUNK_TRACE_WINDOW_MS = 5 * 60 * 1000

export class PlaybackQueue {
  readonly sourceItems: QueueItem[] = []
  readonly readyAudio: ReadyAudioItem[] = []
  private readonly recentChunkTraces = new Map<string, RecentChunkTrace>()
  private queueID = 0
  private readyAudioID = 0

  enqueuePreparedChunk(text: string, pauseMs: number, source: SpeechSource, epoch: number, maxSpeechChunkChars: number, trace?: QueueTrace) {
    if (!text.trim()) return [] as PlaybackQueueEvent[]
    const events: PlaybackQueueEvent[] = []
    if (source === "stream") {
      const coalesced = this.coalesceStreamChunk(text, pauseMs, epoch, maxSpeechChunkChars, trace)
      if (coalesced) events.push(coalesced)
    }
    if (events.length === 0) {
      const fingerprint = textFingerprint(text)
      const duplicate = this.recentChunkTraces.get(fingerprint)
      const item = {
        id: this.queueID++,
        epoch,
        text,
        pauseMs,
        source,
        trace,
      }
      this.sourceItems.push(item)
      this.rememberChunkTrace(fingerprint, item, text)
      events.push({ type: "enqueued", item, fingerprint, duplicate })
    }
    if (source === "stream") events.push(...this.trimStreamQueue())
    return events
  }

  takeSourceItem() {
    return this.sourceItems.shift()
  }

  takeReadyAudioItem() {
    return this.readyAudio.shift()
  }

  enqueueReadyAudio(item: ReadyAudioItem) {
    this.readyAudio.push(item)
  }

  createPauseReadyAudioItem(sourceItem: QueueItem): ReadyAudioItem {
    return {
      id: this.readyAudioID++,
      epoch: sourceItem.epoch,
      sourceItem,
      kind: "pause",
      durationMs: sourceItem.pauseMs,
    }
  }

  createAudioReadyItem(sourceItem: QueueItem, generated: GeneratedAudio): ReadyAudioItem {
    return {
      id: this.readyAudioID++,
      epoch: sourceItem.epoch,
      sourceItem,
      kind: "audio",
      text: generated.text,
      file: generated.file,
    }
  }

  clearSourceItems() {
    this.sourceItems.length = 0
  }

  clearReadyAudio() {
    return this.readyAudio.splice(0)
  }

  cloneQueueItems(items: QueueItem[], epoch: number) {
    return items.map((item) => ({ ...item, epoch }))
  }

  bufferedAudioCount() {
    return this.readyAudio.filter((item) => item.kind === "audio").length
  }

  snapshot() {
    return {
      queueLength: this.sourceItems.length,
      readyAudioLength: this.readyAudio.length,
      recentChunkTraceLength: this.recentChunkTraces.size,
    }
  }

  private coalesceStreamChunk(text: string, pauseMs: number, epoch: number, maxSpeechChunkChars: number, trace?: QueueTrace) {
    if (this.sourceItems.length < STREAM_COALESCE_QUEUE_THRESHOLD) return undefined

    const previous = this.sourceItems.at(-1)
    if (!previous || previous.source !== "stream" || previous.epoch !== epoch) return undefined

    const previousFingerprint = textFingerprint(previous.text)
    const merged = `${previous.text} ${text}`.trim()
    if (merged.length > maxSpeechChunkChars) return undefined

    previous.text = merged
    previous.pauseMs = Math.max(previous.pauseMs, pauseMs)
    previous.trace = {
      ...previous.trace,
      origin: "stream.coalesced",
      chunkCount: (previous.trace?.chunkCount ?? 1) + 1,
      restLength: trace?.restLength ?? previous.trace?.restLength,
    }
    const fingerprint = textFingerprint(previous.text)
    this.recentChunkTraces.delete(previousFingerprint)
    this.rememberChunkTrace(fingerprint, previous, previous.text)
    return { type: "coalesced" as const, item: previous, fingerprint, addedFingerprint: textFingerprint(text), addedTrace: trace }
  }

  private rememberChunkTrace(fingerprint: string, item: QueueItem, text: string) {
    const now = Date.now()
    this.recentChunkTraces.set(fingerprint, {
      queuedAt: now,
      itemID: item.id,
      source: item.source,
      epoch: item.epoch,
      trace: item.trace,
      preview: textPreview(text),
    })

    for (const [key, value] of this.recentChunkTraces) {
      if (this.recentChunkTraces.size <= RECENT_CHUNK_TRACE_LIMIT && now - value.queuedAt <= RECENT_CHUNK_TRACE_WINDOW_MS) break
      this.recentChunkTraces.delete(key)
    }
  }

  private trimStreamQueue() {
    if (this.sourceItems.length <= MAX_STREAM_QUEUE_ITEMS) return [] as PlaybackQueueEvent[]

    let dropCount = this.sourceItems.length - MAX_STREAM_QUEUE_ITEMS
    for (let index = 0; index < this.sourceItems.length && dropCount > 0; ) {
      const item = this.sourceItems[index]
      if (!item || item.source !== "stream") {
        index += 1
        continue
      }
      this.sourceItems.splice(index, 1)
      dropCount -= 1
    }

    if (dropCount === 0) {
      return [{ type: "stream-trimmed" as const, queueLength: this.sourceItems.length, maxQueueLength: MAX_STREAM_QUEUE_ITEMS }]
    }
    return []
  }
}
