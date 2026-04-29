import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Message } from "@opencode-ai/sdk/v2"
import { createLogger } from "../voice-log.js"
import type { VoiceBlock, VoiceConfig } from "../voice-types.js"
import { prepareSpeechText } from "../voice-text.js"
import type { TimerRegistry } from "../shared/timer-registry.js"
import { formatError, textFingerprint, textPreview } from "../shared/voice-utils.js"
import type { SessionStore } from "../session/session-store.js"

const HISTORY_DISPLAY_LIMIT = 50

export type AssistantHistoryEntry = {
  sessionID: string
  messageID: string
  created: number
  text: string
  preview: string
  chronologicalIndex: number
}

type HistoryChangedCallback = (sessionID: string) => void

export class LatestMessageStore {
  private readonly log = createLogger("latest")
  private readonly latestBySession = new Map<string, string>()
  private readonly loadedHistoryBySession = new Map<string, AssistantHistoryEntry[]>()
  private readonly historyLoadBySession = new Map<string, Promise<AssistantHistoryEntry[]>>()
  private readonly historyCallbacks = new Set<HistoryChangedCallback>()

  constructor(
    private readonly api: TuiPluginApi,
    private readonly config: VoiceConfig,
    private readonly timers: TimerRegistry,
    private readonly sessionStore: SessionStore,
  ) {
    this.sessionStore.onDeleted((sessionID) => this.clearSession(sessionID))
  }

  async onMessageUpdated(message: Message) {
    const completed = "completed" in message.time && Boolean(message.time.completed)
    if (message.role !== "assistant" || message.summary || !completed) return
    if (!(await this.sessionStore.shouldSpeakSession(message.sessionID))) return
    this.scheduleLatestRefresh(message.sessionID, message.id)
    this.notifyHistoryChanged(message.sessionID)
  }

  onHistoryChanged(callback: HistoryChangedCallback) {
    this.historyCallbacks.add(callback)
    return () => {
      this.historyCallbacks.delete(callback)
    }
  }

  scheduleLatestRefresh(sessionID: string, messageID: string) {
    this.log.info("schedule latest refresh", { sessionID, messageID })
    this.timers.setTimeout(() => {
      const next = this.collectLatestMessageText(sessionID, messageID)
      if (!next) {
        this.log.warn("latest refresh empty", { sessionID, messageID })
        return
      }
      this.latestBySession.set(sessionID, next)
      this.notifyHistoryChanged(sessionID)
      this.log.info("latest refresh stored", {
        sessionID,
        messageID,
        textLength: next.length,
        fingerprint: textFingerprint(next),
        preview: textPreview(next),
      })
    }, 0)
  }

  replayText(sessionID: string) {
    const cachedLatest = this.latestBySession.get(sessionID)
    return {
      text: cachedLatest ?? this.collectLatestMessageText(sessionID),
      source: cachedLatest ? ("cache" as const) : ("state" as const),
    }
  }

  collectLatestMessageText(sessionID: string, preferredMessageID?: string) {
    const messages = this.api.state.session.messages(sessionID)
    const ordered = preferredMessageID
      ? [
          ...messages.filter((message) => message.id === preferredMessageID),
          ...messages.filter((message) => message.id !== preferredMessageID),
        ]
      : [...messages]

    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const message = ordered[index]
      if (!message || message.role !== "assistant" || message.summary) continue

      const text = this.collectAssistantText(message.id)
      if (!text) continue
      return text
    }

    return undefined
  }

  async collectDisplayHistory(sessionID: string, limit = HISTORY_DISPLAY_LIMIT) {
    if (!(await this.sessionStore.shouldSpeakSession(sessionID))) return []

    return (await this.collectPlayableHistory(sessionID)).slice(-limit).reverse()
  }

  async collectContinuationHistory(sessionID: string, selectedMessageID: string) {
    if (!(await this.sessionStore.shouldSpeakSession(sessionID))) return []

    const entries = await this.collectPlayableHistory(sessionID)
    const start = entries.findIndex((entry) => entry.messageID === selectedMessageID)
    return start === -1 ? [] : entries.slice(start)
  }

  async hasPlayableHistory(sessionID: string) {
    if (!(await this.sessionStore.shouldSpeakSession(sessionID))) return false

    return (await this.collectPlayableHistory(sessionID, 1)).length > 0
  }

  async collectPlayableHistory(sessionID: string, stopAfter?: number) {
    const stateEntries = this.collectStatePlayableHistory(sessionID, stopAfter)
    if (stateEntries.length > 0 || stopAfter === 0) return stateEntries

    const loadedEntries = this.loadedHistoryBySession.get(sessionID) ?? await this.loadSessionHistory(sessionID)
    return stopAfter === undefined ? loadedEntries : loadedEntries.slice(0, stopAfter)
  }

  collectStatePlayableHistory(sessionID: string, stopAfter?: number) {
    const entries: AssistantHistoryEntry[] = []
    const messages = this.api.state.session.messages(sessionID)

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      const completed = message.role === "assistant" && "completed" in message.time && Boolean(message.time.completed)
      if (message.role !== "assistant" || message.summary || !completed) continue

      const text = this.collectAssistantText(message.id)
      if (!text) continue
      entries.push({
        sessionID: message.sessionID,
        messageID: message.id,
        created: message.time.created,
        text,
        preview: textPreview(text),
        chronologicalIndex: index,
      })
      if (stopAfter !== undefined && entries.length >= stopAfter) break
    }

    return entries
  }

  collectAssistantText(messageID: string) {
    const parts = this.api.state.part(messageID)
    const text = parts
      .filter(
        (part): part is Extract<(typeof parts)[number], { type: "text" | "reasoning" }> => {
          if (part.type === "reasoning") return this.isVoiceBlockEnabled("reason")
          if (part.type === "text") return this.isVoiceBlockEnabled("message") && !part.synthetic && !part.ignored
          return false
        },
      )
      .map((part) => part.text)
      .join(" ")

    const prepared = prepareSpeechText(text, this.config.maxSpeechChars, this.config)
    this.log.info("assistant text collected", {
      messageID,
      partCount: parts.length,
      rawLength: text.length,
      preparedLength: prepared.length,
    })
    return prepared || undefined
  }

  clearSession(sessionID: string) {
    this.latestBySession.delete(sessionID)
    this.loadedHistoryBySession.delete(sessionID)
    this.historyLoadBySession.delete(sessionID)
    this.notifyHistoryChanged(sessionID)
  }

  private async loadSessionHistory(sessionID: string) {
    const existing = this.historyLoadBySession.get(sessionID)
    if (existing) return existing

    const load = this.fetchSessionHistory(sessionID).finally(() => {
      this.historyLoadBySession.delete(sessionID)
    })
    this.historyLoadBySession.set(sessionID, load)
    return load
  }

  private async fetchSessionHistory(sessionID: string) {
    try {
      const result = await this.api.client.session.messages({ sessionID })
      if (result.error) {
        this.log.warn("session history lookup failed", { sessionID, error: formatError(result.error) })
        return []
      }

      const entries = (result.data ?? []).flatMap((item, index) => {
        const message = item.info
        const completed = message.role === "assistant" && "completed" in message.time && Boolean(message.time.completed)
        if (message.role !== "assistant" || message.summary || !completed) return []

        const text = this.collectAssistantTextFromParts(item.parts)
        if (!text) return []
        return [{
          sessionID: message.sessionID,
          messageID: message.id,
          created: message.time.created,
          text,
          preview: textPreview(text),
          chronologicalIndex: index,
        }]
      })

      this.loadedHistoryBySession.set(sessionID, entries)
      if (entries.length > 0) this.notifyHistoryChanged(sessionID)
      return entries
    } catch (error) {
      this.log.warn("session history lookup failed", { sessionID, error: formatError(error) })
      return []
    }
  }

  private collectAssistantTextFromParts(parts: ReturnType<TuiPluginApi["state"]["part"]>) {
    const text = parts
      .filter(
        (part): part is Extract<(typeof parts)[number], { type: "text" | "reasoning" }> => {
          if (part.type === "reasoning") return this.isVoiceBlockEnabled("reason")
          if (part.type === "text") return this.isVoiceBlockEnabled("message") && !part.synthetic && !part.ignored
          return false
        },
      )
      .map((part) => part.text)
      .join(" ")

    const prepared = prepareSpeechText(text, this.config.maxSpeechChars, this.config)
    this.log.info("assistant text collected", {
      partCount: parts.length,
      rawLength: text.length,
      preparedLength: prepared.length,
    })
    return prepared || undefined
  }

  private isVoiceBlockEnabled(block: VoiceBlock) {
    return this.config.speechBlocks.includes(block)
  }

  private notifyHistoryChanged(sessionID: string) {
    for (const callback of this.historyCallbacks) callback(sessionID)
  }
}
