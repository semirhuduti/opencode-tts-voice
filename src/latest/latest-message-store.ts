import type { Context } from "@opencode/plugin/tui/context"
import type { SessionMessageInfo } from "@opencode/client"
import { createLogger } from "../voice-log.js"
import type { VoiceConfig } from "../voice-types.js"
import { prepareSpeechText } from "../voice-text.js"
import { formatError, textPreview } from "../shared/voice-utils.js"
import type { SessionStore } from "../session/session-store.js"

export type AssistantHistoryEntry = {
  sessionID: string
  messageID: string
  created: number
  text: string
  preview: string
  chronologicalIndex: number
}

export class LatestMessageStore {
  private readonly log = createLogger("latest")
  private readonly callbacks = new Set<(sessionID: string) => void>()
  private readonly cleanup: () => void
  private readonly pending = new Map<string, Promise<void>>()

  constructor(
    private readonly api: Context,
    private readonly config: VoiceConfig,
    private readonly sessionStore: SessionStore,
  ) {
    this.cleanup = sessionStore.onDeleted((sessionID) => this.notify(sessionID))
  }

  dispose() {
    this.cleanup()
    this.callbacks.clear()
  }

  onHistoryChanged(callback: (sessionID: string) => void) {
    this.callbacks.add(callback)
    return () => { this.callbacks.delete(callback) }
  }

  refresh(sessionID: string) {
    void this.sync(sessionID)
      .then(() => this.notify(sessionID))
      .catch((error) => this.log.warn("history refresh failed", { error: formatError(error) }))
  }

  private sync(sessionID: string) {
    const existing = this.pending.get(sessionID)
    if (existing) return existing
    const request = this.api.data.session.message.sync(sessionID).finally(() => {
      if (this.pending.get(sessionID) === request) this.pending.delete(sessionID)
    })
    this.pending.set(sessionID, request)
    return request
  }

  async replayText(sessionID: string) {
    const entries = await this.collectPlayableHistory(sessionID)
    return { text: entries.at(-1)?.text, source: "state" as const }
  }

  async collectDisplayHistory(sessionID: string, limit = 50) {
    return (await this.collectPlayableHistory(sessionID)).slice(-limit).reverse()
  }

  async collectContinuationHistory(sessionID: string, selectedMessageID: string) {
    const entries = await this.collectPlayableHistory(sessionID)
    const start = entries.findIndex((entry) => entry.messageID === selectedMessageID)
    return start === -1 ? [] : entries.slice(start)
  }

  async hasPlayableHistory(sessionID: string) {
    return (await this.collectPlayableHistory(sessionID)).length > 0
  }

  async collectPlayableHistory(sessionID: string) {
    if (!(await this.sessionStore.shouldSpeakSession(sessionID))) return []
    try {
      await this.sync(sessionID)
    } catch (error) {
      this.log.warn("history refresh failed", { sessionID, error: formatError(error) })
    }
    return this.api.data.session.message.list(sessionID).flatMap((message, index) => {
      const text = this.assistantText(message)
      if (!text || message.type !== "assistant" || !message.time.completed) return []
      return [{
        sessionID,
        messageID: message.id,
        created: message.time.created,
        text,
        preview: textPreview(text),
        chronologicalIndex: index,
      }]
    })
  }

  private assistantText(message: SessionMessageInfo) {
    if (message.type !== "assistant") return undefined
    const text = message.content
      .filter((part) =>
        (part.type === "text" && this.config.speechBlocks.includes("message")) ||
        (part.type === "reasoning" && this.config.speechBlocks.includes("reason")),
      )
      .map((part) => "text" in part ? part.text : "")
      .join(" ")
    return prepareSpeechText(text, this.config.maxSpeechChars, this.config) || undefined
  }

  private notify(sessionID: string) {
    for (const callback of this.callbacks) callback(sessionID)
  }
}
