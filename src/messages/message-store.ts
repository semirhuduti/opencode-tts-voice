import type { Context as TuiPluginApi } from "@opencode/plugin/tui/context"
import type { SessionMessageInfo as Message } from "@opencode/client"
import { createLogger } from "../voice-log.js"
import { formatError } from "../shared/voice-utils.js"

type MessageUpdatedCallback = (message: Message) => Promise<void> | void

export class MessageStore {
  private readonly log = createLogger("messages")
  private readonly messages = new Map<string, Message>()
  private readonly callbacks = new Set<MessageUpdatedCallback>()
  private readonly cleanup: Array<() => void> = []
  private disposed = false

  constructor(private readonly api: TuiPluginApi) {
    this.cleanup.push(
      api.data.on("session.text.ended", (event) => {
        const message = api.data.session.message.get(event.data.sessionID, event.data.assistantMessageID)
        if (message) this.runEventTask("session.text.ended", this.onMessageUpdated(message))
      }),
    )
  }

  onUpdated(callback: MessageUpdatedCallback) {
    this.callbacks.add(callback)
    return () => {
      this.callbacks.delete(callback)
    }
  }

  lookupMessage(sessionID: string, messageID: string) {
    const cached = this.messages.get(messageID)
    if (cached) return cached

    const resolved = this.api.data.session.message.get(sessionID, messageID)
    if (!resolved) {
      this.log.warn("message lookup failed", { sessionID, messageID })
    }
    return resolved
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.cleanup) off()
    this.cleanup.length = 0
    this.callbacks.clear()
    this.messages.clear()
  }

  private async onMessageUpdated(message: Message) {
    const completed = "completed" in message.time && Boolean(message.time.completed)
    this.messages.set(message.id, message)
    this.log.info("message updated", {
      messageID: message.id,
      role: message.type,
      completed,
    })
    for (const callback of this.callbacks) await callback(message)
  }

  private runEventTask(eventName: string, task: Promise<void>) {
    task.catch((error) => {
      this.log.warn("event handler failed", { eventName, error: formatError(error) })
    })
  }
}
