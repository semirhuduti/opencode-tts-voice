import { createSpeechSanitizer, type SpeechSanitizer } from "../voice-sanitize.js"
import { drainStreamChunks } from "../voice-text.js"
import type { PreparedChunk, VoiceBlock, VoiceConfig } from "../voice-types.js"
import { appendSpeechBuffer } from "../shared/voice-utils.js"

export type StreamBlock = Extract<VoiceBlock, "reason" | "message">

export type StreamBufferSnapshot = {
  sessionID: string
  messageID: string
  block: StreamBlock
  rawText: string
  textLength: number
  buffer: string
  completed: boolean
}

export type StreamDeltaResult = {
  startOffset: number
  endOffset: number
  chunks: PreparedChunk[]
  rest: string
  newStream: boolean
}

export type StreamFinalResult = {
  startOffset: number
  endOffset: number
  nextText: string
  chunks: PreparedChunk[]
  rest: string
  finalFlush: boolean
  cursorReset: boolean
  newStream: boolean
}

export class StreamBuffer {
  rawText = ""
  textLength = 0
  buffer = ""
  sanitizer?: SpeechSanitizer
  completed = false

  constructor(
    readonly sessionID: string,
    readonly messageID: string,
    public block: StreamBlock,
  ) {}

  applyDelta(delta: string, block: StreamBlock, config: VoiceConfig, newStream: boolean) {
    this.block = block
    this.sanitizer ??= createSpeechSanitizer(config)
    const startOffset = this.textLength
    this.rawText += delta
    this.textLength = this.rawText.length
    this.buffer = appendSpeechBuffer(this.buffer, this.sanitizer.push(delta, false))
    const drained = drainStreamChunks(this.buffer, config, false)
    this.buffer = drained.rest
    return {
      startOffset,
      endOffset: this.textLength,
      chunks: drained.chunks,
      rest: drained.rest,
      newStream,
    }
  }

  storeSnapshot(block: StreamBlock) {
    this.block = block
  }

  applyFinal(text: string, block: StreamBlock, config: VoiceConfig, newStream: boolean) {
    this.block = block
    this.sanitizer ??= createSpeechSanitizer(config)
    let nextText = ""
    const startOffset = this.rawText.length
    let cursorReset = false
    if (text.length >= this.rawText.length && text.startsWith(this.rawText)) {
      nextText = text.slice(this.rawText.length)
    } else {
      cursorReset = true
    }
    this.rawText = text
    this.textLength = text.length
    this.buffer = appendSpeechBuffer(this.buffer, this.sanitizer.push(nextText, true))
    const drained = drainStreamChunks(this.buffer, config, true)
    this.buffer = drained.rest
    this.completed = true
    this.buffer = ""
    return {
      startOffset,
      endOffset: this.textLength,
      nextText,
      chunks: drained.chunks,
      rest: drained.rest,
      finalFlush: true,
      cursorReset,
      newStream,
    }
  }

  snapshot(): StreamBufferSnapshot {
    return {
      sessionID: this.sessionID,
      messageID: this.messageID,
      block: this.block,
      rawText: this.rawText,
      textLength: this.textLength,
      buffer: this.buffer,
      completed: this.completed,
    }
  }
}
