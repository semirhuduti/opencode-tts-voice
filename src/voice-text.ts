import type { PreparedChunk, VoiceConfig } from "./voice-types.js"
import { sanitizeSpeechText, type SpeechSanitizerOptions } from "./voice-sanitize.js"

const STRONG_BOUNDARY = /[.!?\n]/

function clampTextLength(text: string, maxTextLength: number) {
  if (text.length <= maxTextLength) return text
  return `${text.slice(0, Math.max(0, maxTextLength - 3)).trimEnd()}...`
}

function normalizePreparedText(text: string) {
  return text
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function prepareSanitizedSpeechText(text: string, maxTextLength: number) {
  const cleaned = normalizePreparedText(text)
  if (!cleaned) return ""
  return clampTextLength(cleaned, maxTextLength)
}

export function prepareSpeechText(text: string, maxTextLength: number, options?: SpeechSanitizerOptions) {
  return prepareSanitizedSpeechText(sanitizeSpeechText(text, options), maxTextLength)
}

function classifyPause(text: string, config: VoiceConfig) {
  if (/[.!?;:]$/.test(text)) return config.sentencePauseMs
  return config.normalPauseMs
}

function findBoundary(text: string, minCut: number, maxCut: number) {
  for (let index = maxCut - 1; index >= minCut - 1; index -= 1) {
    const char = text[index]
    if (char && STRONG_BOUNDARY.test(char)) return index + 1
  }

  return undefined
}

function takeChunk(text: string, config: VoiceConfig, final: boolean) {
  const input = text.trimStart()
  if (!input) return undefined

  const newline = input.indexOf("\n")
  if (newline >= 0 && (final || newline > 0)) {
    const raw = input.slice(0, newline).trim()
    const rest = input.slice(newline + 1).trimStart()
    const prepared = prepareSanitizedSpeechText(raw, config.maxSpeechChars)

    return {
      rest,
      chunk: prepared
        ? {
            text: prepared,
            pauseMs: config.sentencePauseMs,
          }
        : undefined,
    }
  }

  const hardLimit = Math.min(config.maxSpeechChunkChars, input.length)
  const softLimit = Math.min(config.streamFlushChars, hardLimit)

  if (!final && input.length < softLimit) return undefined

  let cut = findBoundary(input, softLimit, hardLimit)
  if (!cut && (final || input.length >= config.maxSpeechChunkChars)) {
    cut = findBoundary(input, 1, hardLimit)
  }
  if (!cut && final) cut = input.length
  if (!cut) return undefined

  const raw = input.slice(0, cut).trim()
  const rest = input.slice(cut).trimStart()
  const prepared = prepareSanitizedSpeechText(raw, config.maxSpeechChars)

  return {
    rest,
    chunk: prepared
      ? {
          text: prepared,
          pauseMs: classifyPause(prepared, config),
        }
      : undefined,
  }
}

export function drainStreamChunks(text: string, config: VoiceConfig, final = false) {
  const chunks: PreparedChunk[] = []
  let rest = text

  while (rest) {
    const next = takeChunk(rest, config, final)
    if (!next) break
    rest = next.rest
    if (next.chunk) chunks.push(next.chunk)
    if (!final && rest.length < config.streamFlushChars) break
  }

  return { chunks, rest }
}

export function splitPlaybackText(text: string, config: VoiceConfig) {
  const prepared = prepareSpeechText(text, config.maxSpeechChars, config)
  if (!prepared) return [] as PreparedChunk[]

  const chunks: PreparedChunk[] = []
  let rest = prepared
  while (rest) {
    const next = takeChunk(rest, config, true)
    if (!next) break
    rest = next.rest
    if (next.chunk) chunks.push(next.chunk)
  }
  return chunks
}
