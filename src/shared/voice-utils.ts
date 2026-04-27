const LOG_PREVIEW_LENGTH = 120

export function formatError(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

export function appendSpeechBuffer(buffer: string, text: string) {
  const next = text.trim()
  if (!next) return buffer
  return buffer ? `${buffer} ${next}` : next
}

export function textPreview(text: string) {
  const compact = text.replace(/\s+/g, " ").trim()
  return compact.length > LOG_PREVIEW_LENGTH ? `${compact.slice(0, LOG_PREVIEW_LENGTH)}...` : compact
}

export function textFingerprint(text: string) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${text.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`
}

export function activeSessionID(route: { name: string; params?: Record<string, unknown> }) {
  if (route.name !== "session") return undefined
  return typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined
}
