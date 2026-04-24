import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { spawn, type ChildProcess } from "node:child_process"
import * as fsSync from "node:fs"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { KV_ENABLED, PLAYER_CANDIDATES, PLAYER_DEFAULT_ARGS } from "./voice-constants.js"
import { trimSilence, wavFromFloat32 } from "./voice-audio.js"
import { KokoroRuntime } from "./voice-kokoro.js"
import { createLogger } from "./voice-log.js"
import { drainStreamChunks, prepareSpeechText, splitPlaybackText } from "./voice-text.js"
import type { SpeechSource, VoiceConfig, VoiceState } from "./voice-types.js"

type Listener = () => void

type QueueItem = {
  id: number
  epoch: number
  text: string
  pauseMs: number
  source: SpeechSource
}

type StreamBuffer = {
  sessionID: string
  messageID: string
  lastText: string
  buffer: string
}

type CurrentTask = {
  item: QueueItem
  phase: "generate" | "play"
  interrupted: boolean
  requeue: boolean
  child?: ChildProcess
}

function formatError(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function isMissingBinary(error: unknown): error is NodeJS.ErrnoException {
  return error !== null && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function toBasePlayer(playerBin: string) {
  return path.basename(playerBin).toLowerCase()
}

function isExecutable(file: string) {
  try {
    fsSync.accessSync(file, fsSync.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveExecutable(playerBin: string) {
  if (playerBin.includes(path.sep)) {
    return isExecutable(playerBin) ? playerBin : undefined
  }

  const envPath = process.env.PATH ?? ""
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, playerBin)
    if (isExecutable(candidate)) return candidate
  }

  return undefined
}

export class VoiceController {
  private readonly log = createLogger("controller")
  private readonly listeners = new Set<Listener>()
  private readonly messages = new Map<string, Message>()
  private readonly latestBySession = new Map<string, string>()
  private readonly streams = new Map<string, StreamBuffer>()
  private readonly cleanup: Array<() => void> = []
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly runtime: KokoroRuntime

  private readonly queue: QueueItem[] = []
  private current?: CurrentTask
  private wake?: () => void
  private loopStarted = false
  private disposed = false
  private tmpDir?: Promise<string>
  private queueID = 0
  private epoch = 0
  private lastToastAt = 0
  private resolvedPlayer?: string

  private state: VoiceState

  constructor(
    private readonly api: TuiPluginApi,
    private readonly config: VoiceConfig,
  ) {
    this.state = {
      enabled: api.kv.get(KV_ENABLED, true),
      paused: false,
      busy: false,
      playing: false,
      backend: config.playerBin,
      device: config.device,
      error: undefined,
    }

    this.runtime = new KokoroRuntime(config, (status) => this.setState(status), createLogger("kokoro"))

    this.log.info("init", {
      enabled: this.state.enabled,
      device: this.config.device,
      playerBin: this.config.playerBin,
      readResponses: this.config.readResponses,
      announceOnIdle: this.config.announceOnIdle,
    })

    this.cleanup.push(
      api.event.on("message.updated", (event) => this.onMessageUpdated(event.properties.info)),
      api.event.on("message.part.delta", (event) => this.onMessagePartDelta(event.properties)),
      api.event.on("message.part.updated", (event) => this.onMessagePartUpdated(event.properties.part)),
      api.event.on("session.idle", (event) => this.onSessionIdle(event.properties.sessionID)),
    )

    this.startLoop()
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot() {
    return { ...this.state }
  }

  async preloadRuntime() {
    if (!this.state.enabled) {
      this.log.info("runtime preload skipped", { enabled: false })
      return
    }

    this.log.info("runtime preload start")
    try {
      const runtime = await this.runtime.preload()
      this.log.info("runtime preload complete", { device: runtime.device })
    } catch (error) {
      await this.handleRuntimeError(error)
    }
  }

  async toggleEnabled() {
    const next = !this.state.enabled
    this.log.info("toggle enabled", { next })
    this.api.kv.set(KV_ENABLED, next)
    if (!next) {
      await this.resetQueue(false)
      this.streams.clear()
      this.setState({ enabled: false, paused: false })
      this.api.ui.toast({ variant: "info", message: "Speech disabled" })
      return
    }

    this.setState({ enabled: true, paused: false, error: undefined })
    this.notify()
    this.api.ui.toast({ variant: "success", message: "Speech enabled" })
  }

  async togglePlayback(sessionID?: string) {
    this.log.info("toggle playback", {
      sessionID: sessionID ?? this.activeSessionID(),
      paused: this.state.paused,
      busy: this.state.busy,
      queueLength: this.queue.length,
      hasCurrent: Boolean(this.current),
    })
    if (!this.state.enabled) {
      this.api.ui.toast({ variant: "warning", message: "Speech is disabled" })
      return
    }

    if (this.state.paused) {
      this.resumeQueue()
      this.api.ui.toast({ variant: "info", message: "Speech resumed" })
      return
    }

    if (this.current || this.queue.length > 0) {
      this.pauseQueue()
      this.api.ui.toast({ variant: "info", message: "Speech paused" })
      return
    }

    await this.replayLatest(sessionID)
  }

  async replayLatest(sessionID?: string) {
    this.log.info("replay latest requested", { sessionID: sessionID ?? this.activeSessionID() })
    if (!this.state.enabled) {
      this.api.ui.toast({ variant: "warning", message: "Speech is disabled" })
      return false
    }

    const activeSessionID = sessionID ?? this.activeSessionID()
    if (!activeSessionID) {
      this.api.ui.toast({ variant: "warning", message: "No active session" })
      return false
    }

    const latest = this.latestBySession.get(activeSessionID) ?? this.collectLatestMessageText(activeSessionID)
    if (!latest) {
      this.log.warn("replay latest unavailable", { sessionID: activeSessionID })
      this.api.ui.toast({ variant: "warning", message: "No assistant message available" })
      return false
    }

    await this.resetQueue(false)
    this.setState({ paused: false })

    for (const chunk of splitPlaybackText(latest, this.config)) {
      this.enqueuePreparedChunk(chunk.text, chunk.pauseMs, "latest")
    }

    if (!this.queue.length) {
      this.api.ui.toast({ variant: "warning", message: "No assistant message available" })
      return false
    }

    this.notify()
    this.log.info("replay latest queued", {
      sessionID: activeSessionID,
      queueLength: this.queue.length,
      textLength: latest.length,
    })
    this.api.ui.toast({ variant: "info", message: "Replaying latest assistant message" })
    return true
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true

    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()

    for (const off of this.cleanup) off()
    this.cleanup.length = 0

    await this.resetQueue(false)
    this.notify()
    this.log.info("dispose")

    const dir = this.tmpDir
    this.tmpDir = undefined
    if (!dir) return

    const value = await dir.catch(() => undefined)
    if (!value) return
    await fs.rm(value, { recursive: true, force: true }).catch(() => undefined)
  }

  private setState(patch: Partial<VoiceState>) {
    let changed = false
    const changedFields: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch) as Array<[keyof VoiceState, VoiceState[keyof VoiceState]]>) {
      if (this.state[key] === value) continue
      ;(this.state[key] as VoiceState[keyof VoiceState]) = value
      changedFields[key] = value
      changed = true
    }
    if (!changed) return
    this.log.info("state changed", changedFields)
    for (const listener of this.listeners) listener()
  }

  private activeSessionID() {
    const route = this.api.route.current
    if (route.name !== "session") return undefined
    return typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined
  }

  private startLoop() {
    if (this.loopStarted) return
    this.loopStarted = true

    void (async () => {
      this.log.info("queue loop started")
      while (!this.disposed) {
        const item = await this.takeNextItem()
        if (!item || this.disposed) continue

        this.log.info("queue item start", {
          itemID: item.id,
          source: item.source,
          textLength: item.text.length,
          pauseMs: item.pauseMs,
          queueRemaining: this.queue.length,
        })

        const current: CurrentTask = {
          item,
          phase: "generate",
          interrupted: false,
          requeue: false,
        }
        this.current = current
        this.syncActivity()

        let file: string | undefined
        try {
          const generated = await this.runtime.generate(item.text)
          if (this.shouldRequeue(current)) {
            this.log.info("queue item requeued after generate", { itemID: item.id })
            this.queue.unshift(item)
            continue
          }
          if (this.isStale(item)) {
            this.log.warn("queue item stale after generate", { itemID: item.id, epoch: item.epoch, currentEpoch: this.epoch })
            continue
          }

          file = await this.writeAudioFile(generated.audio, generated.sampleRate)
          current.phase = "play"
          await this.playFile(file, current)

          if (this.shouldRequeue(current)) {
            this.log.info("queue item requeued after playback", { itemID: item.id })
            this.queue.unshift(item)
            continue
          }
          if (this.isStale(item)) {
            this.log.warn("queue item stale after playback", { itemID: item.id, epoch: item.epoch, currentEpoch: this.epoch })
            continue
          }

          if (item.pauseMs > 0) await this.sleep(item.pauseMs)
          this.log.info("queue item complete", { itemID: item.id })
        } catch (error) {
          this.log.error("queue item failed", {
            itemID: item.id,
            source: item.source,
            phase: current.phase,
            error: formatError(error),
          })
          if (!current.interrupted || !current.requeue) {
            await this.handleRuntimeError(error)
          }
        } finally {
          if (file) await fs.unlink(file).catch(() => undefined)
          if (this.current === current) this.current = undefined
          this.syncActivity()
        }
      }
    })()
  }

  private async takeNextItem() {
    while (!this.disposed) {
      if (this.state.enabled && !this.state.paused && this.queue.length > 0) {
        return this.queue.shift()
      }

      this.syncActivity()
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = undefined
    }

    return undefined
  }

  private notify() {
    this.wake?.()
    this.syncActivity()
  }

  private syncActivity() {
    this.setState({
      busy: Boolean(this.current) || this.queue.length > 0,
      playing: this.current?.phase === "play",
    })
  }

  private pauseQueue() {
    this.log.info("pause queue", {
      queueLength: this.queue.length,
      hasCurrent: Boolean(this.current),
      currentPhase: this.current?.phase,
    })
    this.setState({ paused: true })
    if (!this.current) return
    this.current.interrupted = true
    this.current.requeue = true
    if (this.current.phase === "play") this.stopChild(this.current.child)
  }

  private resumeQueue() {
    this.log.info("resume queue", { queueLength: this.queue.length })
    this.setState({ paused: false })
    this.notify()
  }

  private async resetQueue(requeueCurrent: boolean) {
    this.log.info("reset queue", {
      requeueCurrent,
      queueLength: this.queue.length,
      hasCurrent: Boolean(this.current),
      nextEpoch: this.epoch + 1,
    })
    this.epoch += 1
    this.queue.length = 0
    if (this.current) {
      this.current.interrupted = true
      this.current.requeue = requeueCurrent
      if (this.current.phase === "play") this.stopChild(this.current.child)
    }
    this.notify()
  }

  private shouldRequeue(current: CurrentTask) {
    return current.requeue && this.state.paused && current.item.epoch === this.epoch && this.state.enabled
  }

  private isStale(item: QueueItem) {
    return item.epoch !== this.epoch || !this.state.enabled
  }

  private enqueuePreparedChunk(text: string, pauseMs: number, source: SpeechSource) {
    if (!text.trim()) return
    const item = {
      id: this.queueID++,
      epoch: this.epoch,
      text,
      pauseMs,
      source,
    }
    this.queue.push(item)
    this.log.info("chunk enqueued", {
      itemID: item.id,
      source,
      epoch: item.epoch,
      textLength: text.length,
      pauseMs,
      queueLength: this.queue.length,
      preview: text.slice(0, 80),
    })
  }

  private onMessageUpdated(message: Message) {
    const completed = "completed" in message.time && Boolean(message.time.completed)
    this.messages.set(message.id, message)
    this.log.info("message updated", {
      messageID: message.id,
      sessionID: message.sessionID,
      role: message.role,
      completed,
      summary: Boolean(message.summary),
    })
    if (message.role !== "assistant" || message.summary || !completed) return
    this.scheduleLatestRefresh(message.sessionID, message.id)
  }

  private onMessagePartDelta(event: { sessionID: string; messageID: string; partID: string; field: string; delta: string }) {
    if (!this.config.readResponses || event.field !== "text") return

    const message = this.lookupMessage(event.sessionID, event.messageID)
    if (!message || message.role !== "assistant" || message.summary || !this.state.enabled) {
      this.log.warn("stream delta ignored", {
        sessionID: event.sessionID,
        messageID: event.messageID,
        partID: event.partID,
        hasMessage: Boolean(message),
        role: message?.role,
        summary: Boolean(message?.summary),
        enabled: this.state.enabled,
      })
      return
    }

    const stream = this.streams.get(event.partID) ?? {
      sessionID: event.sessionID,
      messageID: event.messageID,
      lastText: "",
      buffer: "",
    }

    stream.lastText += event.delta
    stream.buffer += event.delta

    const drained = drainStreamChunks(stream.buffer, this.config, false)
    stream.buffer = drained.rest
    if (drained.chunks.length > 0) {
      this.log.info("stream chunks drained", {
        sessionID: event.sessionID,
        messageID: event.messageID,
        partID: event.partID,
        chunkCount: drained.chunks.length,
        restLength: drained.rest.length,
      })
    }
    for (const chunk of drained.chunks) {
      this.enqueuePreparedChunk(chunk.text, chunk.pauseMs, "stream")
    }

    this.streams.set(event.partID, stream)
    this.notify()
  }

  private onMessagePartUpdated(part: Part) {
    if (part.type !== "text" || part.synthetic || part.ignored) return

    const message = this.lookupMessage(part.sessionID, part.messageID)
    if (!message || message.role !== "assistant" || message.summary) {
      this.log.warn("part update ignored", {
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
        hasMessage: Boolean(message),
        role: message?.role,
        summary: Boolean(message?.summary),
      })
      return
    }

    const text = typeof part.text === "string" ? part.text : ""
    const stream = this.streams.get(part.id) ?? {
      sessionID: part.sessionID,
      messageID: part.messageID,
      lastText: "",
      buffer: "",
    }

    if (text.startsWith(stream.lastText)) {
      stream.buffer += text.slice(stream.lastText.length)
    }
    stream.lastText = text

    if (this.state.enabled && this.config.readResponses) {
      const drained = drainStreamChunks(stream.buffer, this.config, Boolean(part.time?.end))
      stream.buffer = drained.rest
      if (drained.chunks.length > 0 || part.time?.end) {
        this.log.info("part updated", {
          sessionID: part.sessionID,
          messageID: part.messageID,
          partID: part.id,
          textLength: text.length,
          chunkCount: drained.chunks.length,
          restLength: drained.rest.length,
          ended: Boolean(part.time?.end),
        })
      }
      for (const chunk of drained.chunks) {
        this.enqueuePreparedChunk(chunk.text, chunk.pauseMs, "stream")
      }
      this.notify()
    }

    if (part.time?.end) {
      this.log.info("part completed", {
        sessionID: part.sessionID,
        messageID: part.messageID,
        partID: part.id,
        finalTextLength: text.length,
      })
      this.streams.delete(part.id)
      this.scheduleLatestRefresh(part.sessionID, part.messageID)
      return
    }

    this.streams.set(part.id, stream)
  }

  private onSessionIdle(sessionID: string) {
    if (!this.state.enabled || !this.config.announceOnIdle) return
    const active = this.activeSessionID()
    if (active && active !== sessionID) return

    this.log.info("session idle announcement", { sessionID })

    for (const chunk of splitPlaybackText(this.config.idleMessage, this.config)) {
      this.enqueuePreparedChunk(chunk.text, chunk.pauseMs, "idle")
    }
    this.notify()
  }

  private lookupMessage(sessionID: string, messageID: string) {
    const cached = this.messages.get(messageID)
    if (cached) return cached

    const resolved = this.api.state.session.messages(sessionID).find((message) => message.id === messageID)
    if (!resolved) {
      this.log.warn("message lookup failed", { sessionID, messageID })
    }
    return resolved
  }

  private scheduleLatestRefresh(sessionID: string, messageID: string) {
    this.log.info("schedule latest refresh", { sessionID, messageID })
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      const next = this.collectLatestMessageText(sessionID, messageID)
      if (!next) {
        this.log.warn("latest refresh empty", { sessionID, messageID })
        return
      }
      this.latestBySession.set(sessionID, next)
      this.log.info("latest refresh stored", { sessionID, messageID, textLength: next.length })
    }, 0)
    this.timers.add(timer)
  }

  private collectLatestMessageText(sessionID: string, preferredMessageID?: string) {
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

  private collectAssistantText(messageID: string) {
    const parts = this.api.state.part(messageID)
    const text = parts
      .filter(
        (part): part is Extract<(typeof parts)[number], { type: "text" }> =>
          part.type === "text" && !part.synthetic && !part.ignored,
      )
      .map((part) => part.text)
      .join(" ")

    const prepared = prepareSpeechText(text, this.config.maxTextLength)
    this.log.info("assistant text collected", {
      messageID,
      partCount: parts.length,
      rawLength: text.length,
      preparedLength: prepared.length,
    })
    return prepared || undefined
  }

  private async writeAudioFile(audio: Float32Array, sampleRate: number) {
    const dir = await this.ensureTempDir()
    const trimmed = trimSilence(audio, sampleRate, this.config.trimSilenceThreshold, this.config.leadingAudioPadMs)
    const file = path.join(dir, `${Date.now()}-${this.queueID}.wav`)
    await fs.writeFile(file, wavFromFloat32(trimmed, sampleRate))
    this.log.info("audio file written", {
      file,
      sampleRate,
      inputSamples: audio.length,
      outputSamples: trimmed.length,
    })
    return file
  }

  private async ensureTempDir() {
    if (!this.tmpDir) {
      this.tmpDir = fs.mkdtemp(path.join(os.tmpdir(), "opencode-tts-voice-"))
      this.log.info("temp dir requested")
    }
    const dir = await this.tmpDir
    this.log.info("temp dir ready", { dir })
    return dir
  }

  private buildPlayerArgs(file: string) {
    const playerBin = this.resolvedPlayer ?? this.config.playerBin
    const base = toBasePlayer(playerBin)
    const defaults = PLAYER_DEFAULT_ARGS[base] ?? []
    return [...defaults, ...this.config.playerArgs, file]
  }

  private resolvePlayerBin() {
    if (this.resolvedPlayer) return this.resolvedPlayer

    const preferred = this.config.playerBin.trim()
    const candidates = preferred && preferred !== "auto" ? [preferred, ...PLAYER_CANDIDATES] : [...PLAYER_CANDIDATES]
    this.log.info("resolve player start", { preferred, candidates })

    for (const candidate of candidates) {
      const resolved = resolveExecutable(candidate)
      this.log.info("resolve player candidate", { candidate, resolved: resolved ?? null })
      if (!resolved) continue
      this.resolvedPlayer = resolved
      this.setState({ backend: toBasePlayer(resolved) })
      this.log.info("resolve player success", { playerBin: resolved, backend: toBasePlayer(resolved) })
      return resolved
    }

    throw new Error(
      `No supported audio player found. Install one of: ${PLAYER_CANDIDATES.join(", ")}`,
    )
  }

  private async playFile(file: string, current: CurrentTask) {
    const playerBin = this.resolvePlayerBin()
    await new Promise<void>((resolve, reject) => {
      const args = this.buildPlayerArgs(file)
      this.log.info("playback spawn", {
        itemID: current.item.id,
        playerBin,
        args,
        file,
      })
      const child = spawn(playerBin, this.buildPlayerArgs(file), {
        stdio: ["ignore", "ignore", "pipe"],
      })

      current.child = child
      let settled = false
      let stderr = ""

      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += String(chunk)
      })

      const done = (callback: () => void) => {
        if (settled) return
        settled = true
        callback()
      }

      child.once("error", (error) => {
        this.log.error("playback process error", {
          itemID: current.item.id,
          playerBin,
          error: formatError(error),
          stderr: stderr || undefined,
        })
        done(() => reject(error))
      })

      child.once("exit", (code, signal) => {
        this.log.info("playback process exit", {
          itemID: current.item.id,
          playerBin,
          code,
          signal,
          interrupted: current.interrupted,
          stderr: stderr.trim() || undefined,
        })
        if (current.interrupted && (signal || code !== 0)) {
          done(resolve)
          return
        }
        if (code === 0) {
          done(resolve)
          return
        }
        done(() => reject(new Error(`${toBasePlayer(playerBin)} exited with code ${code ?? "unknown"}`)))
      })
    })
  }

  private stopChild(child?: ChildProcess) {
    if (!child || child.killed) return
    this.log.info("stop child", { pid: child.pid ?? null })
    child.kill("SIGTERM")
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!child.killed) child.kill("SIGKILL")
    }, 250)
    this.timers.add(timer)
  }

  private async handleRuntimeError(error: unknown) {
    const message = formatError(error)
    this.log.error("runtime error", { error: message })
    this.setState({ error: message })

    if (isMissingBinary(error)) {
      this.api.kv.set(KV_ENABLED, false)
      this.setState({ enabled: false, paused: false })
      this.queue.length = 0
      this.toastError(`Playback failed. Command not found: ${this.config.playerBin}`)
      return
    }

    this.toastError(`Speech failed. ${message}`)
  }

  private toastError(message: string) {
    const now = Date.now()
    if (now - this.lastToastAt < 5000) return
    this.lastToastAt = now
    this.api.ui.toast({ variant: "error", message })
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        resolve()
      }, ms)
      this.timers.add(timer)
    })
  }
}
