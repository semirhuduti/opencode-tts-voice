import { createLogger } from "../voice-log.js"
import type { VoiceConfig } from "../voice-types.js"
import { splitPlaybackText } from "../voice-text.js"
import type { LatestMessageStore } from "../latest/latest-message-store.js"
import type { PlaybackPipeline } from "../playback/playback-pipeline.js"
import type { SessionStore } from "../session/session-store.js"
import type { VoiceStateStore } from "../state/voice-state-store.js"
import { activeSessionID, textFingerprint, textPreview } from "../shared/voice-utils.js"

type Toast = (input: { variant: "info" | "success" | "warning" | "error"; message: string }) => void

export class VoiceCommands {
  private readonly log = createLogger("commands")

  constructor(
    private readonly route: { current: { name: string; params?: Record<string, unknown> } },
    private readonly config: VoiceConfig,
    private readonly state: VoiceStateStore,
    private readonly playback: PlaybackPipeline,
    private readonly sessionStore: SessionStore,
    private readonly latestStore: LatestMessageStore,
    private readonly toast: Toast,
  ) {}

  async toggleEnabled() {
    const next = !this.state.snapshot().enabled
    this.log.info("toggle enabled", { next })
    if (!next) {
      await this.playback.reset(false)
      this.state.setEnabled(false)
      this.state.patch({ paused: false })
      this.toast({ variant: "info", message: "Speech disabled" })
      return
    }

    this.state.setEnabled(true)
    this.state.patch({ paused: false, error: undefined })
    this.state.notifyNow()
    this.toast({ variant: "success", message: "Speech enabled" })
  }

  async togglePlayback(sessionID?: string) {
    const current = this.state.snapshot()
    this.log.info("toggle playback", {
      sessionID: sessionID ?? this.activeSessionID(),
      paused: current.paused,
      busy: current.busy,
    })
    if (!current.enabled) {
      this.toast({ variant: "warning", message: "Speech is disabled" })
      return
    }

    if (current.paused) {
      this.playback.resume()
      this.toast({ variant: "info", message: "Speech resumed" })
      return
    }

    if (this.playback.isBusy()) {
      this.playback.pause()
      this.toast({ variant: "info", message: "Speech paused" })
      return
    }

    await this.replayLatest(sessionID)
  }

  async replayLatest(sessionID?: string) {
    this.log.info("replay latest requested", { sessionID: sessionID ?? this.activeSessionID() })
    if (!this.state.snapshot().enabled) {
      this.toast({ variant: "warning", message: "Speech is disabled" })
      return false
    }

    const active = sessionID ?? this.activeSessionID()
    if (!active) {
      this.toast({ variant: "warning", message: "No active session" })
      return false
    }
    if (!(await this.sessionStore.shouldSpeakSession(active))) {
      this.toast({ variant: "warning", message: "Subagent speech is disabled" })
      return false
    }

    const latest = this.latestStore.replayText(active)
    if (!latest.text) {
      this.log.warn("replay latest unavailable", { sessionID: active })
      this.toast({ variant: "warning", message: "No assistant message available" })
      return false
    }
    const latestText = latest.text

    await this.playback.reset(false)
    this.state.patch({ paused: false })

    const chunks = splitPlaybackText(latestText, this.config)
    chunks.forEach((chunk, index) => {
      this.playback.enqueuePreparedChunk(chunk.text, chunk.pauseMs, "latest", {
        origin: "replayLatest",
        sessionID: active,
        replaySource: latest.source,
        fullTextLength: latestText.length,
        chunkIndex: index,
        chunkCount: chunks.length,
      })
    })

    if (!this.playback.isBusy()) {
      this.toast({ variant: "warning", message: "No assistant message available" })
      return false
    }

    this.log.info("replay latest queued", {
      sessionID: active,
      textLength: latestText.length,
      replaySource: latest.source,
      fingerprint: textFingerprint(latestText),
      preview: textPreview(latestText),
    })
    this.toast({ variant: "info", message: "Replaying latest assistant message" })
    return true
  }

  private activeSessionID() {
    return activeSessionID(this.route.current)
  }
}
