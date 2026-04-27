import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Message } from "@opencode-ai/sdk/v2"
import { createLogger } from "../voice-log.js"
import type { VoiceBlock, VoiceConfig } from "../voice-types.js"
import { prepareSpeechText } from "../voice-text.js"
import type { TimerRegistry } from "../shared/timer-registry.js"
import { textFingerprint, textPreview } from "../shared/voice-utils.js"
import type { SessionStore } from "../session/session-store.js"

export class LatestMessageStore {
  private readonly log = createLogger("latest")
  private readonly latestBySession = new Map<string, string>()

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

    const prepared = prepareSpeechText(text, this.config.maxSpeechChars)
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
  }

  private isVoiceBlockEnabled(block: VoiceBlock) {
    return this.config.speechBlocks.includes(block)
  }
}
