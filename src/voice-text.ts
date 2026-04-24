import type { PreparedChunk, VoiceConfig } from "./voice-types.js"

const STRONG_BOUNDARY = /[.!?\n]/
const CLAUSE_BOUNDARY = /[,;:]/
const TRAILING_CLOSERS = /[\s"')\]}]+/

function clampTextLength(text: string, maxTextLength: number) {
  if (text.length <= maxTextLength) return text
  return `${text.slice(0, Math.max(0, maxTextLength - 3)).trimEnd()}...`
}

export function prepareSpeechText(text: string, maxTextLength: number) {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " Code omitted. ")
    .replace(/```+/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()

  if (!cleaned) return ""
  return clampTextLength(cleaned, maxTextLength)
}

function classifyPause(text: string, config: VoiceConfig) {
  if (/[.!?;:]$/.test(text)) return config.clauseChunkPauseMs
  return config.defaultChunkPauseMs
}

function consumeBoundary(text: string, index: number) {
  let next = index
  while (next < text.length) {
    const char = text[next]
    if (!char) break
    if (TRAILING_CLOSERS.test(char)) {
      next += 1
      continue
    }
    break
  }
  return next
}

function findBoundary(text: string, minCut: number, maxCut: number) {
  for (let index = maxCut - 1; index >= minCut - 1; index -= 1) {
    const char = text[index]
    if (char && STRONG_BOUNDARY.test(char)) return consumeBoundary(text, index + 1)
  }

  for (let index = maxCut - 1; index >= minCut - 1; index -= 1) {
    const char = text[index]
    if (char && CLAUSE_BOUNDARY.test(char)) return consumeBoundary(text, index + 1)
  }

  for (let index = maxCut - 1; index >= minCut - 1; index -= 1) {
    if (/\s/.test(text[index] ?? "")) return index + 1
  }

  return undefined
}

function takeChunk(text: string, config: VoiceConfig, final: boolean) {
  const input = text.trimStart()
  if (!input) return undefined

  const hardLimit = Math.min(config.speechChunkLength, input.length)
  const softLimit = Math.min(config.streamSoftLimit, hardLimit)

  if (!final && input.length < softLimit) return undefined

  let cut = findBoundary(input, softLimit, hardLimit)
  if (!cut && (final || input.length >= config.speechChunkLength)) {
    cut = findBoundary(input, 1, hardLimit) ?? Math.min(hardLimit, input.length)
  }
  if (!cut && final) cut = input.length
  if (!cut) return undefined

  const raw = input.slice(0, cut).trim()
  const rest = input.slice(cut).trimStart()
  const prepared = prepareSpeechText(raw, config.maxTextLength)

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
    if (!final && rest.length < config.streamSoftLimit) break
  }

  return { chunks, rest }
}

export function splitPlaybackText(text: string, config: VoiceConfig) {
  const prepared = prepareSpeechText(text, config.maxTextLength)
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
