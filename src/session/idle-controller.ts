import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createLogger } from "../voice-log.js"
import type { VoiceConfig } from "../voice-types.js"
import { splitPlaybackText } from "../voice-text.js"
import type { PlaybackPipeline } from "../playback/playback-pipeline.js"
import type { SessionStore } from "./session-store.js"
import type { VoiceStateStore } from "../state/voice-state-store.js"
import { activeSessionID, formatError } from "../shared/voice-utils.js"

export class IdleController {
  private readonly log = createLogger("idle")
  private readonly cleanup: Array<() => void> = []
  private disposed = false

  constructor(
    private readonly api: TuiPluginApi,
    private readonly config: VoiceConfig,
    private readonly state: VoiceStateStore,
    private readonly playback: PlaybackPipeline,
    private readonly sessionStore: SessionStore,
  ) {
    this.cleanup.push(api.event.on("session.idle", (event) => this.runEventTask("session.idle", this.onSessionIdle(event.properties.sessionID))))
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.cleanup) off()
    this.cleanup.length = 0
  }

  private runEventTask(eventName: string, task: Promise<void>) {
    task.catch((error) => {
      this.log.warn("event handler failed", { eventName, error: formatError(error) })
    })
  }

  private async onSessionIdle(sessionID: string) {
    if (!this.state.snapshot().enabled || !this.config.speakOnIdle || !this.config.speechBlocks.includes("idle")) return
    if (!(await this.sessionStore.shouldSpeakSession(sessionID))) return
    const active = activeSessionID(this.api.route.current)
    if (active && active !== sessionID) return

    this.log.info("session idle announcement", { sessionID })

    const chunks = splitPlaybackText(this.config.idleAnnouncement, this.config)
    chunks.forEach((chunk, index) => {
      this.playback.enqueuePreparedChunk(chunk.text, chunk.pauseMs, "idle", {
        origin: "session.idle",
        sessionID,
        fullTextLength: this.config.idleAnnouncement.length,
        chunkIndex: index,
        chunkCount: chunks.length,
      })
    })
  }
}
