import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { spawn, type ChildProcess } from "node:child_process"
import * as fsSync from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { KV_ENABLED, PLAYER_CANDIDATES, PLAYER_DEFAULT_ARGS } from "./voice-constants.js"
import { TtsHelperRuntime } from "./voice-helper-runtime.js"
import { createLogger } from "./voice-log.js"
import { createSpeechSanitizer, type SpeechSanitizer } from "./voice-sanitize.js"
import { drainStreamChunks, prepareSpeechText, splitPlaybackText } from "./voice-text.js"
import type { SpeechSource, VoiceBlock, VoiceConfig, VoiceState } from "./voice-types.js"

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
  block: Extract<VoiceBlock, "reason" | "message">
  textLength: number
  buffer: string
  sanitizer: SpeechSanitizer
}

type GenerateTask = {
  item: QueueItem
  interrupted: boolean
}

type GeneratedAudio = {
  text: string
  file: string
}

type ReadyAudioItem =
  | {
      id: number
      epoch: number
      sourceItem: QueueItem
      kind: "audio"
      text: string
      file: string
    }
  | {
      id: number
      epoch: number
      sourceItem: QueueItem
      kind: "pause"
      durationMs: number
    }

type PlayTask = {
  item: ReadyAudioItem
  interrupted: boolean
  child?: ChildProcess
}

type SessionParentInfo = {
  id?: string | null
  parentID?: string | null
}

const READY_AUDIO_BUFFER = 1
const LISTENER_NOTIFY_DELAY_MS = 50
const STREAM_COALESCE_QUEUE_THRESHOLD = 4
const MAX_STREAM_QUEUE_ITEMS = 32

function formatError(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function appendSpeechBuffer(buffer: string, text: string) {
  const next = text.trim()
  if (!next) return buffer
  return buffer ? `${buffer} ${next}` : next
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
  private readonly sessionParents = new Map<string, string | undefined>()
  private readonly sessionParentLookups = new Map<string, Promise<string | undefined>>()
  private readonly latestBySession = new Map<string, string>()
  private readonly streams = new Map<string, StreamBuffer>()
  private readonly cleanup: Array<() => void> = []
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly runtime: TtsHelperRuntime

  private readonly queue: QueueItem[] = []
  private readonly readyAudio: ReadyAudioItem[] = []
  private currentGenerate?: GenerateTask
  private currentPlay?: PlayTask
  private queueWake?: () => void
  private playbackWake?: () => void
  private listenerTimer?: NodeJS.Timeout
  private loopStarted = false
  private disposed = false
  private queueID = 0
  private readyAudioID = 0
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
      generating: false,
      playing: false,
      backend: config.playerBin,
      device: config.device,
      error: undefined,
    }

    this.runtime = new TtsHelperRuntime(config, (status) => this.setState(status), createLogger("helper"))

    this.log.info("init", {
      enabled: this.state.enabled,
      device: this.config.device,
      playerBin: this.config.playerBin,
      readResponses: this.config.readResponses,
      readSubagentResponses: this.config.readSubagentResponses,
      announceOnIdle: this.config.announceOnIdle,
    })

    this.cleanup.push(
      api.event.on("session.created", (event) => this.cacheSession(event.properties.sessionID, event.properties.info)),
      api.event.on("session.updated", (event) => this.cacheSession(event.properties.sessionID, event.properties.info)),
      api.event.on("session.deleted", (event) => this.forgetSession(event.properties.sessionID)),
      api.event.on("message.updated", (event) => this.runEventTask("message.updated", this.onMessageUpdated(event.properties.info))),
      api.event.on("message.part.delta", (event) => this.runEventTask("message.part.delta", this.onMessagePartDelta(event.properties))),
      api.event.on("message.part.updated", (event) => this.runEventTask("message.part.updated", this.onMessagePartUpdated(event.properties.part))),
      api.event.on("session.idle", (event) => this.runEventTask("session.idle", this.onSessionIdle(event.properties.sessionID))),
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
      readyAudioLength: this.readyAudio.length,
      hasCurrentGenerate: Boolean(this.currentGenerate),
      hasCurrentPlay: Boolean(this.currentPlay),
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

    if (this.currentGenerate || this.currentPlay || this.readyAudio.length > 0 || this.queue.length > 0) {
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
    if (!(await this.shouldSpeakSession(activeSessionID))) {
      this.api.ui.toast({ variant: "warning", message: "Subagent speech is disabled" })
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
    if (this.listenerTimer) {
      clearTimeout(this.listenerTimer)
      this.listenerTimer = undefined
    }

    for (const off of this.cleanup) off()
    this.cleanup.length = 0

    await this.resetQueue(false)
    this.notify()
    this.scheduleListenerNotify(true)
    this.log.info("dispose")
    await this.runtime.dispose().catch((error) => {
      this.log.warn("helper dispose failed", { error: formatError(error) })
    })
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
    this.log.debug("state changed", changedFields)
    this.scheduleListenerNotify()
  }

  private scheduleListenerNotify(immediate = false) {
    if (this.disposed && !immediate) return

    if (this.listenerTimer) {
      if (!immediate) return
      clearTimeout(this.listenerTimer)
      this.timers.delete(this.listenerTimer)
      this.listenerTimer = undefined
    }

    if (immediate) {
      for (const listener of this.listeners) listener()
      return
    }

    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (this.listenerTimer === timer) this.listenerTimer = undefined
      for (const listener of this.listeners) listener()
    }, LISTENER_NOTIFY_DELAY_MS)
    this.listenerTimer = timer
    this.timers.add(timer)
  }

  private activeSessionID() {
    const route = this.api.route.current
    if (route.name !== "session") return undefined
    return typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined
  }

  private runEventTask(eventName: string, task: Promise<void>) {
    task.catch((error) => {
      this.log.warn("event handler failed", { eventName, error: formatError(error) })
    })
  }

  private cacheSession(sessionID: string, session: SessionParentInfo) {
    const id = typeof session.id === "string" && session.id ? session.id : sessionID
    const hasParentID = "parentID" in session
    const parentID = typeof session.parentID === "string" && session.parentID ? session.parentID : undefined

    if (hasParentID) this.sessionParents.set(id, parentID)
    this.sessionParentLookups.delete(id)
    this.log.debug("session cached", {
      sessionID: id,
      parentID: this.sessionParents.get(id) ?? null,
      subagent: Boolean(this.sessionParents.get(id)),
    })
  }

  private forgetSession(sessionID: string) {
    this.sessionParents.delete(sessionID)
    this.sessionParentLookups.delete(sessionID)
    this.latestBySession.delete(sessionID)

    for (const [partID, stream] of this.streams) {
      if (stream.sessionID === sessionID) this.streams.delete(partID)
    }
  }

  private async sessionParentID(sessionID: string) {
    if (this.sessionParents.has(sessionID)) return this.sessionParents.get(sessionID)

    const existing = this.sessionParentLookups.get(sessionID)
    if (existing) return existing

    const lookup = this.fetchSessionParentID(sessionID).finally(() => {
      this.sessionParentLookups.delete(sessionID)
    })
    this.sessionParentLookups.set(sessionID, lookup)
    return lookup
  }

  private async fetchSessionParentID(sessionID: string) {
    try {
      const result = await this.api.client.session.get({ sessionID })
      if (result.data) {
        this.cacheSession(sessionID, result.data)
        return result.data.parentID
      }

      this.log.warn("session lookup failed", {
        sessionID,
        error: result.error ? formatError(result.error) : undefined,
      })
    } catch (error) {
      this.log.warn("session lookup failed", { sessionID, error: formatError(error) })
    }

    this.sessionParents.set(sessionID, undefined)
    return undefined
  }

  private async shouldSpeakSession(sessionID: string) {
    if (this.config.readSubagentResponses) return true

    const parentID = await this.sessionParentID(sessionID)
    const allowed = !parentID
    if (!allowed) {
      this.log.debug("speech skipped for subagent session", { sessionID, parentID })
    }
    return allowed
  }

  private startLoop() {
    if (this.loopStarted) return
    this.loopStarted = true

    void this.runGenerationLoop()
    void this.runPlaybackLoop()
  }

  private async runGenerationLoop() {
    this.log.info("generation loop started")
    while (!this.disposed) {
      const item = await this.takeNextQueueItem()
      if (!item || this.disposed) continue

      this.log.info("queue item start", {
        itemID: item.id,
        source: item.source,
        textLength: item.text.length,
        pauseMs: item.pauseMs,
        queueRemaining: this.queue.length,
      })

      const current: GenerateTask = {
        item,
        interrupted: false,
      }
      this.currentGenerate = current
      this.syncActivity()

      let segmentCount = 0
      let queuedPause = false
      try {
        for await (const generated of this.runtime.stream(item.text, item.epoch)) {
          if (!(await this.waitForReadyAudioCapacity(current))) {
            await fs.unlink(generated.file).catch(() => undefined)
            break
          }

          const ready = await this.createAudioReadyItem(item, generated)
          if (!ready) {
            if (current.interrupted || this.isStale(item)) break
            continue
          }
          if (current.interrupted || this.isStale(item)) {
            await this.discardReadyAudio([ready])
            break
          }

          this.enqueueReadyAudio(ready)
          segmentCount += 1
        }

        if (!current.interrupted && !this.isStale(item) && item.pauseMs > 0) {
          const canQueuePause = await this.waitForReadyAudioCapacity(current)
          if (canQueuePause && !current.interrupted && !this.isStale(item)) {
            this.enqueueReadyAudio(this.createPauseReadyAudioItem(item))
            queuedPause = true
          }
        }

        if (current.interrupted) {
          this.log.info("queue item interrupted", {
            itemID: item.id,
            source: item.source,
            segmentCount,
          })
          continue
        }
        if (this.isStale(item)) {
          this.log.warn("queue item stale after generate", { itemID: item.id, epoch: item.epoch, currentEpoch: this.epoch })
          continue
        }

        this.log.info("queue item generated", {
          itemID: item.id,
          source: item.source,
          segmentCount,
          queuedPause,
          readyAudioLength: this.readyAudio.length,
        })
      } catch (error) {
        this.log.error("queue item failed", {
          itemID: item.id,
          source: item.source,
          phase: "generate",
          error: formatError(error),
        })
        if (!current.interrupted && !this.isStale(item)) {
          await this.handleRuntimeError(error)
        }
      } finally {
        if (this.currentGenerate === current) this.currentGenerate = undefined
        this.syncActivity()
        this.notify()
      }
    }
  }

  private async runPlaybackLoop() {
    this.log.info("playback loop started")
    while (!this.disposed) {
      const item = await this.takeNextReadyAudio()
      if (!item || this.disposed) continue

      const current: PlayTask = {
        item,
        interrupted: false,
      }
      this.currentPlay = current
      this.syncActivity()

      try {
        if (item.kind === "pause") {
          this.log.info("playback pause start", {
            readyAudioID: item.id,
            sourceItemID: item.sourceItem.id,
            durationMs: item.durationMs,
          })
          if (item.durationMs > 0) await this.sleep(item.durationMs)
        } else {
          this.log.info("ready audio start", {
            readyAudioID: item.id,
            sourceItemID: item.sourceItem.id,
            textLength: item.text.length,
            readyAudioRemaining: this.readyAudio.length,
          })
          await this.playFile(item.file, current)
        }

        if (current.interrupted) {
          this.log.info("ready audio interrupted", {
            readyAudioID: item.id,
            sourceItemID: item.sourceItem.id,
            kind: item.kind,
          })
          continue
        }
        if (this.isStale(item.sourceItem)) {
          this.log.warn("ready audio stale after playback", {
            readyAudioID: item.id,
            sourceItemID: item.sourceItem.id,
            epoch: item.sourceItem.epoch,
            currentEpoch: this.epoch,
          })
          continue
        }

        this.log.info("ready audio complete", {
          readyAudioID: item.id,
          sourceItemID: item.sourceItem.id,
          kind: item.kind,
        })
      } catch (error) {
        this.log.error("ready audio failed", {
          readyAudioID: item.id,
          sourceItemID: item.sourceItem.id,
          kind: item.kind,
          phase: "play",
          error: formatError(error),
        })
        if (!current.interrupted && !this.isStale(item.sourceItem)) {
          await this.handleRuntimeError(error)
        }
      } finally {
        if (item.kind === "audio") await fs.unlink(item.file).catch(() => undefined)
        if (this.currentPlay === current) this.currentPlay = undefined
        this.syncActivity()
        this.notify()
      }
    }
  }

  private async takeNextQueueItem() {
    while (!this.disposed) {
      if (this.state.enabled && !this.state.paused && this.bufferedAudioCount() < READY_AUDIO_BUFFER && this.queue.length > 0) {
        const item = this.takeQueueItem()
        if (!item || this.isStale(item)) continue
        return item
      }

      this.syncActivity()
      await this.waitForQueueSignal()
    }

    return undefined
  }

  private async waitForReadyAudioCapacity(current: GenerateTask) {
    while (!this.disposed && !current.interrupted && !this.isStale(current.item)) {
      if (this.state.enabled && !this.state.paused && this.bufferedAudioCount() < READY_AUDIO_BUFFER) {
        return true
      }

      this.syncActivity()
      await this.waitForQueueSignal()
    }

    return false
  }

  private async takeNextReadyAudio() {
    while (!this.disposed) {
      if (this.state.enabled && !this.state.paused && this.readyAudio.length > 0) {
        const item = this.takeReadyAudioItem()
        if (!item) continue
        if (this.isStale(item.sourceItem)) {
          await this.discardReadyAudio([item])
          continue
        }
        return item
      }

      this.syncActivity()
      await this.waitForPlaybackSignal()
    }

    return undefined
  }

  private waitForQueueSignal() {
    return new Promise<void>((resolve) => {
      this.queueWake = resolve
    })
  }

  private waitForPlaybackSignal() {
    return new Promise<void>((resolve) => {
      this.playbackWake = resolve
    })
  }

  private notify() {
    const queueWake = this.queueWake
    this.queueWake = undefined
    queueWake?.()

    const playbackWake = this.playbackWake
    this.playbackWake = undefined
    playbackWake?.()

    this.syncActivity()
  }

  private takeQueueItem() {
    return this.queue.shift()
  }

  private takeReadyAudioItem() {
    return this.readyAudio.shift()
  }

  private syncActivity() {
    this.setState({
      busy: Boolean(this.currentGenerate) || Boolean(this.currentPlay) || this.readyAudio.length > 0 || this.queue.length > 0,
      generating: Boolean(this.currentGenerate),
      playing: Boolean(this.currentPlay),
    })
  }

  private pauseQueue() {
    const requeued = this.collectBufferedSourceItems()
    const bufferedReadyAudio = this.readyAudio.splice(0)
    this.log.info("pause queue", {
      queueLength: this.queue.length,
      readyAudioLength: bufferedReadyAudio.length,
      hasCurrentGenerate: Boolean(this.currentGenerate),
      hasCurrentPlay: Boolean(this.currentPlay),
      requeuedCount: requeued.length,
    })
    this.setState({ paused: true })
    if (requeued.length > 0) this.queue.unshift(...requeued)

    if (this.currentGenerate) {
      this.currentGenerate.interrupted = true
    }
    if (this.currentPlay) {
      this.currentPlay.interrupted = true
      if (this.currentPlay.item.kind === "audio") this.stopChild(this.currentPlay.child)
    }

    if (bufferedReadyAudio.length > 0) {
      void this.discardReadyAudio(bufferedReadyAudio)
    }
    this.notify()
  }

  private resumeQueue() {
    this.log.info("resume queue", {
      queueLength: this.queue.length,
      readyAudioLength: this.readyAudio.length,
    })
    this.setState({ paused: false })
    this.notify()
  }

  private async resetQueue(requeueCurrent: boolean) {
    const requeued = requeueCurrent ? this.cloneQueueItems(this.collectBufferedSourceItems(), this.epoch + 1) : []
    const bufferedReadyAudio = this.readyAudio.splice(0)
    this.log.info("reset queue", {
      requeueCurrent,
      queueLength: this.queue.length,
      readyAudioLength: bufferedReadyAudio.length,
      hasCurrentGenerate: Boolean(this.currentGenerate),
      hasCurrentPlay: Boolean(this.currentPlay),
      requeuedCount: requeued.length,
      nextEpoch: this.epoch + 1,
    })
    this.epoch += 1
    void this.runtime.cancelEpoch(this.epoch - 1)
    this.queue.length = 0
    if (requeued.length > 0) this.queue.push(...requeued)

    if (this.currentGenerate) {
      this.currentGenerate.interrupted = true
      void this.runtime.cancelEpoch(this.currentGenerate.item.epoch)
    }
    if (this.currentPlay) {
      this.currentPlay.interrupted = true
      if (this.currentPlay.item.kind === "audio") this.stopChild(this.currentPlay.child)
    }

    await this.discardReadyAudio(bufferedReadyAudio)
    this.notify()
  }

  private collectBufferedSourceItems() {
    const items: QueueItem[] = []
    const seen = new Set<number>()

    const add = (item: QueueItem | undefined) => {
      if (!item || this.isStale(item) || seen.has(item.id)) return
      seen.add(item.id)
      items.push(item)
    }

    add(this.currentPlay?.item.sourceItem)
    for (const item of this.readyAudio) add(item.sourceItem)
    add(this.currentGenerate?.item)

    return items
  }

  private cloneQueueItems(items: QueueItem[], epoch: number) {
    return items.map((item) => ({ ...item, epoch }))
  }

  private bufferedAudioCount() {
    return this.readyAudio.filter((item) => item.kind === "audio").length
  }

  private isStale(item: QueueItem) {
    return item.epoch !== this.epoch || !this.state.enabled
  }

  private enqueuePreparedChunk(text: string, pauseMs: number, source: SpeechSource) {
    if (!text.trim()) return
    if (source === "stream" && this.coalesceStreamChunk(text, pauseMs)) {
      this.trimStreamQueue()
      return
    }

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
    if (source === "stream") this.trimStreamQueue()
  }

  private coalesceStreamChunk(text: string, pauseMs: number) {
    if (this.queue.length < STREAM_COALESCE_QUEUE_THRESHOLD) return false

    const previous = this.queue.at(-1)
    if (!previous || previous.source !== "stream" || previous.epoch !== this.epoch) return false

    const merged = `${previous.text} ${text}`.trim()
    if (merged.length > this.config.speechChunkLength) return false

    previous.text = merged
    previous.pauseMs = Math.max(previous.pauseMs, pauseMs)
    this.log.debug("stream chunk coalesced", {
      itemID: previous.id,
      textLength: previous.text.length,
      queueLength: this.queue.length,
    })
    return true
  }

  private trimStreamQueue() {
    if (this.queue.length <= MAX_STREAM_QUEUE_ITEMS) return

    let dropCount = this.queue.length - MAX_STREAM_QUEUE_ITEMS
    for (let index = 0; index < this.queue.length && dropCount > 0; ) {
      const item = this.queue[index]
      if (!item || item.source !== "stream") {
        index += 1
        continue
      }
      this.queue.splice(index, 1)
      dropCount -= 1
    }

    if (dropCount === 0) {
      this.log.warn("stream queue trimmed", { queueLength: this.queue.length, maxQueueLength: MAX_STREAM_QUEUE_ITEMS })
    }
  }

  private enqueueReadyAudio(item: ReadyAudioItem) {
    this.readyAudio.push(item)
    if (item.kind === "pause") {
      this.log.info("pause queued", {
        readyAudioID: item.id,
        sourceItemID: item.sourceItem.id,
        durationMs: item.durationMs,
        readyAudioLength: this.readyAudio.length,
      })
    } else {
      this.log.info("audio queued", {
        readyAudioID: item.id,
        sourceItemID: item.sourceItem.id,
        textLength: item.text.length,
        readyAudioLength: this.readyAudio.length,
      })
    }
    this.notify()
  }

  private createPauseReadyAudioItem(sourceItem: QueueItem): ReadyAudioItem {
    return {
      id: this.readyAudioID++,
      epoch: sourceItem.epoch,
      sourceItem,
      kind: "pause",
      durationMs: sourceItem.pauseMs,
    }
  }

  private async createAudioReadyItem(sourceItem: QueueItem, generated: GeneratedAudio) {
    const id = this.readyAudioID++
    if (this.isStale(sourceItem)) {
      await fs.unlink(generated.file).catch(() => undefined)
      return undefined
    }

    return {
      id,
      epoch: sourceItem.epoch,
      sourceItem,
      kind: "audio" as const,
      text: generated.text,
      file: generated.file,
    }
  }

  private async discardReadyAudio(items: ReadyAudioItem[]) {
    if (!items.length) return
    await Promise.all(
      items.map((item) => {
        if (item.kind !== "audio") return Promise.resolve()
        return fs.unlink(item.file).catch(() => undefined)
      }),
    )
  }

  private isVoiceBlockEnabled(block: VoiceBlock) {
    return this.config.voiceBlocks.includes(block)
  }

  private blockForPart(part: Part): Extract<VoiceBlock, "reason" | "message"> | undefined {
    if (part.type === "reasoning") return "reason"
    if (part.type === "text" && !part.synthetic && !part.ignored) return "message"
    return undefined
  }

  private blockForDelta(event: { messageID: string; partID: string; field: string }) {
    if (event.field === "reasoning_content" || event.field === "reasoning_details") return "reason" as const
    if (event.field !== "text") return undefined

    const buffered = this.streams.get(event.partID)
    if (buffered) return buffered.block

    const part = this.lookupPart(event.messageID, event.partID)
    return part ? this.blockForPart(part) : "message"
  }

  private async onMessageUpdated(message: Message) {
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
    if (!(await this.shouldSpeakSession(message.sessionID))) return
    this.scheduleLatestRefresh(message.sessionID, message.id)
  }

  private async onMessagePartDelta(event: { sessionID: string; messageID: string; partID: string; field: string; delta: string }) {
    if (!this.config.readResponses) return
    if (!(await this.shouldSpeakSession(event.sessionID))) {
      this.streams.delete(event.partID)
      return
    }

    const block = this.blockForDelta(event)
    if (!block || !this.isVoiceBlockEnabled(block)) return

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
      block,
      textLength: 0,
      buffer: "",
      sanitizer: createSpeechSanitizer(),
    }
    stream.block = block

    stream.textLength += event.delta.length
    stream.buffer = appendSpeechBuffer(stream.buffer, stream.sanitizer.push(event.delta, false))

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
    if (drained.chunks.length > 0) this.notify()
  }

  private async onMessagePartUpdated(part: Part) {
    if (part.type !== "text" && part.type !== "reasoning") return
    if (!(await this.shouldSpeakSession(part.sessionID))) {
      this.streams.delete(part.id)
      return
    }

    const block = this.blockForPart(part)
    if (!block) return

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
      block,
      textLength: 0,
      buffer: "",
      sanitizer: createSpeechSanitizer(),
    }
    stream.block = block

    let nextText = ""
    if (text.length >= stream.textLength) {
      nextText = text.slice(stream.textLength)
    } else {
      stream.buffer = ""
      stream.sanitizer = createSpeechSanitizer()
      nextText = text
    }
    stream.textLength = text.length
    const finalFlush = Boolean(part.time?.end)
    stream.buffer = appendSpeechBuffer(stream.buffer, stream.sanitizer.push(nextText, finalFlush))

    if (this.state.enabled && this.config.readResponses && this.isVoiceBlockEnabled(block)) {
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

  private async onSessionIdle(sessionID: string) {
    if (!this.state.enabled || !this.config.announceOnIdle || !this.isVoiceBlockEnabled("idle")) return
    if (!(await this.shouldSpeakSession(sessionID))) return
    const active = this.activeSessionID()
    if (active && active !== sessionID) return

    this.log.info("session idle announcement", { sessionID })

    for (const chunk of splitPlaybackText(this.config.idleMessage, this.config)) {
      this.enqueuePreparedChunk(chunk.text, chunk.pauseMs, "idle")
    }
    this.notify()
  }

  private lookupPart(messageID: string, partID: string) {
    return this.api.state.part(messageID).find((part) => part.id === partID)
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
        (part): part is Extract<(typeof parts)[number], { type: "text" | "reasoning" }> => {
          if (part.type === "reasoning") return this.isVoiceBlockEnabled("reason")
          if (part.type === "text") return this.isVoiceBlockEnabled("message") && !part.synthetic && !part.ignored
          return false
        },
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

  private async playFile(file: string, current: PlayTask) {
    const playerBin = this.resolvePlayerBin()
    await new Promise<void>((resolve, reject) => {
      const args = this.buildPlayerArgs(file)
      this.log.info("playback spawn", {
        itemID: current.item.id,
        playerBin,
        args,
        file,
      })
      const child = spawn(playerBin, args, {
        stdio: ["ignore", "ignore", "pipe"],
      })

      current.child = child
      let settled = false
      let stderr = ""

      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = `${stderr}${String(chunk)}`.slice(-2000)
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
      const bufferedReadyAudio = this.readyAudio.splice(0)
      this.api.kv.set(KV_ENABLED, false)
      this.setState({ enabled: false, paused: false })
      this.queue.length = 0
      if (this.currentGenerate) {
        this.currentGenerate.interrupted = true
        void this.runtime.cancelEpoch(this.currentGenerate.item.epoch)
      }
      if (this.currentPlay) this.currentPlay.interrupted = true
      await this.discardReadyAudio(bufferedReadyAudio)
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
