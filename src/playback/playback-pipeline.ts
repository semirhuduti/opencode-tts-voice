import * as fs from "node:fs/promises"
import { TtsHelperRuntime } from "../voice-helper-runtime.js"
import { createLogger } from "../voice-log.js"
import type { SpeechSource, VoiceConfig, VoiceState } from "../voice-types.js"
import type { TimerRegistry } from "../shared/timer-registry.js"
import { formatError, textFingerprint, textPreview } from "../shared/voice-utils.js"
import type { VoiceStateStore } from "../state/voice-state-store.js"
import { isMissingBinary, PlayerService, type PlayFileTask } from "./player-service.js"
import { PlaybackQueue, type QueueItem, type QueueTrace, type ReadyAudioItem } from "./queue.js"

type GenerateTask = {
  item: QueueItem
  interrupted: boolean
}

type PlayTask = PlayFileTask & {
  item: ReadyAudioItem
}

type Toast = (input: { variant: "info" | "success" | "warning" | "error"; message: string }) => void

const READY_AUDIO_BUFFER = 1

export class PlaybackPipeline {
  private readonly log = createLogger("playback")
  private readonly runtime: TtsHelperRuntime
  private readonly player: PlayerService
  private readonly queue = new PlaybackQueue()
  private currentGenerate?: GenerateTask
  private currentPlay?: PlayTask
  private queueWake?: () => void
  private playbackWake?: () => void
  private loopStarted = false
  private disposed = false
  private epoch = 0
  private lastToastAt = 0

  constructor(
    private readonly config: VoiceConfig,
    private readonly state: VoiceStateStore,
    private readonly timers: TimerRegistry,
    private readonly toast: Toast,
  ) {
    this.runtime = new TtsHelperRuntime(config, (status) => this.state.patch(status), createLogger("helper"))
    this.player = new PlayerService(config, this.log, timers, (backend) => this.state.patch({ backend }))
  }

  start() {
    if (this.loopStarted) return
    this.loopStarted = true
    void this.runGenerationLoop()
    void this.runPlaybackLoop()
  }

  enqueuePreparedChunk(text: string, pauseMs: number, source: SpeechSource, trace?: QueueTrace) {
    const events = this.queue.enqueuePreparedChunk(text, pauseMs, source, this.epoch, this.config.maxSpeechChunkChars, trace)
    for (const event of events) {
      if (event.type === "enqueued") {
        if (event.duplicate) {
          this.log.warn("duplicate chunk enqueued", {
            itemID: event.item.id,
            source,
            epoch: event.item.epoch,
            textLength: text.length,
            fingerprint: event.fingerprint,
            preview: textPreview(text),
            trace,
            previousItemID: event.duplicate.itemID,
            previousSource: event.duplicate.source,
            previousEpoch: event.duplicate.epoch,
            previousAgeMs: Date.now() - event.duplicate.queuedAt,
            previousPreview: event.duplicate.preview,
            previousTrace: event.duplicate.trace,
          })
        }
        this.log.info("chunk enqueued", {
          itemID: event.item.id,
          source,
          epoch: event.item.epoch,
          textLength: text.length,
          fingerprint: event.fingerprint,
          pauseMs,
          queueLength: this.queue.sourceItems.length,
          preview: textPreview(text),
          trace,
        })
        continue
      }

      if (event.type === "coalesced") {
        this.log.debug("stream chunk coalesced", {
          itemID: event.item.id,
          textLength: event.item.text.length,
          fingerprint: event.fingerprint,
          addedFingerprint: event.addedFingerprint,
          queueLength: this.queue.sourceItems.length,
          addedTrace: event.addedTrace,
          trace: event.item.trace,
        })
        continue
      }

      this.log.warn("stream queue trimmed", { queueLength: event.queueLength, maxQueueLength: event.maxQueueLength })
    }
    if (events.length > 0) this.notify()
    return events.length
  }

  isBusy() {
    return Boolean(this.currentGenerate) || Boolean(this.currentPlay) || this.queue.readyAudio.length > 0 || this.queue.sourceItems.length > 0
  }

  pause() {
    const requeued = this.collectBufferedSourceItems()
    const bufferedReadyAudio = this.queue.clearReadyAudio()
    this.log.info("pause queue", {
      queueLength: this.queue.sourceItems.length,
      readyAudioLength: bufferedReadyAudio.length,
      hasCurrentGenerate: Boolean(this.currentGenerate),
      hasCurrentPlay: Boolean(this.currentPlay),
      requeuedCount: requeued.length,
    })
    this.state.patch({ paused: true })
    if (requeued.length > 0) this.queue.sourceItems.unshift(...requeued)

    if (this.currentGenerate) {
      this.currentGenerate.interrupted = true
    }
    if (this.currentPlay) {
      this.currentPlay.interrupted = true
      if (this.currentPlay.item.kind === "audio") this.player.stopChild(this.currentPlay.child)
    }

    if (bufferedReadyAudio.length > 0) {
      void this.discardReadyAudio(bufferedReadyAudio)
    }
    this.notify()
  }

  resume() {
    this.log.info("resume queue", {
      queueLength: this.queue.sourceItems.length,
      readyAudioLength: this.queue.readyAudio.length,
    })
    this.state.patch({ paused: false })
    this.notify()
  }

  async reset(requeueCurrent: boolean) {
    const requeued = requeueCurrent ? this.queue.cloneQueueItems(this.collectBufferedSourceItems(), this.epoch + 1) : []
    const bufferedReadyAudio = this.queue.clearReadyAudio()
    this.log.info("reset queue", {
      requeueCurrent,
      queueLength: this.queue.sourceItems.length,
      readyAudioLength: bufferedReadyAudio.length,
      hasCurrentGenerate: Boolean(this.currentGenerate),
      hasCurrentPlay: Boolean(this.currentPlay),
      requeuedCount: requeued.length,
      nextEpoch: this.epoch + 1,
    })
    this.epoch += 1
    void this.runtime.cancelEpoch(this.epoch - 1)
    this.queue.clearSourceItems()
    if (requeued.length > 0) this.queue.sourceItems.push(...requeued)

    if (this.currentGenerate) {
      this.currentGenerate.interrupted = true
      void this.runtime.cancelEpoch(this.currentGenerate.item.epoch)
    }
    if (this.currentPlay) {
      this.currentPlay.interrupted = true
      if (this.currentPlay.item.kind === "audio") this.player.stopChild(this.currentPlay.child)
    }

    await this.discardReadyAudio(bufferedReadyAudio)
    this.notify()
  }

  async dispose() {
    if (this.disposed) return
    const hadCurrentAudio = this.currentPlay?.item.kind === "audio"
    this.disposed = true
    await this.reset(false)
    if (hadCurrentAudio) await this.timers.sleep(260)
    this.notify()
    this.log.info("dispose")
    await this.runtime.dispose().catch((error) => {
      this.log.warn("helper dispose failed", { error: formatError(error) })
    })
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
        fingerprint: textFingerprint(item.text),
        preview: textPreview(item.text),
        trace: item.trace,
        pauseMs: item.pauseMs,
        queueRemaining: this.queue.sourceItems.length,
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
            this.enqueueReadyAudio(this.queue.createPauseReadyAudioItem(item))
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
          readyAudioLength: this.queue.readyAudio.length,
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
        id: item.id,
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
          if (item.durationMs > 0) await this.timers.sleep(item.durationMs)
        } else {
          this.log.info("ready audio start", {
            readyAudioID: item.id,
            sourceItemID: item.sourceItem.id,
            textLength: item.text.length,
            fingerprint: textFingerprint(item.text),
            preview: textPreview(item.text),
            readyAudioRemaining: this.queue.readyAudio.length,
          })
          await this.player.playFile(item.file, current)
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
          source: item.sourceItem.source,
          trace: item.sourceItem.trace,
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
      const state = this.state.snapshot()
      if (state.enabled && !state.paused && this.queue.bufferedAudioCount() < READY_AUDIO_BUFFER && this.queue.sourceItems.length > 0) {
        const item = this.queue.takeSourceItem()
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
      const state = this.state.snapshot()
      if (state.enabled && !state.paused && this.queue.bufferedAudioCount() < READY_AUDIO_BUFFER) {
        return true
      }

      this.syncActivity()
      await this.waitForQueueSignal()
    }

    return false
  }

  private async takeNextReadyAudio() {
    while (!this.disposed) {
      const state = this.state.snapshot()
      if (state.enabled && !state.paused && this.queue.readyAudio.length > 0) {
        const item = this.queue.takeReadyAudioItem()
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

  private syncActivity() {
    this.state.patch({
      busy: this.isBusy(),
      generating: Boolean(this.currentGenerate),
      playing: Boolean(this.currentPlay),
    })
  }

  private collectBufferedSourceItems() {
    const items: QueueItem[] = []
    const seen = new Set<number>()

    const add = (item: QueueItem | undefined, bufferSource: string) => {
      if (!item || this.isStale(item) || seen.has(item.id)) return
      seen.add(item.id)
      items.push(item)
      this.log.info("buffered item retained", {
        bufferSource,
        itemID: item.id,
        source: item.source,
        epoch: item.epoch,
        textLength: item.text.length,
        fingerprint: textFingerprint(item.text),
        preview: textPreview(item.text),
        trace: item.trace,
      })
    }

    if (this.currentPlay?.item.kind === "audio") add(this.currentPlay.item.sourceItem, "currentPlay")
    for (const item of this.queue.readyAudio) {
      if (item.kind === "audio") add(item.sourceItem, "readyAudio")
    }
    add(this.currentGenerate?.item, "currentGenerate")

    return items
  }

  private isStale(item: QueueItem) {
    return item.epoch !== this.epoch || !this.state.snapshot().enabled
  }

  private enqueueReadyAudio(item: ReadyAudioItem) {
    this.queue.enqueueReadyAudio(item)
    if (item.kind === "pause") {
      this.log.info("pause queued", {
        readyAudioID: item.id,
        sourceItemID: item.sourceItem.id,
        source: item.sourceItem.source,
        durationMs: item.durationMs,
        readyAudioLength: this.queue.readyAudio.length,
        trace: item.sourceItem.trace,
      })
    } else {
      this.log.info("audio queued", {
        readyAudioID: item.id,
        sourceItemID: item.sourceItem.id,
        source: item.sourceItem.source,
        textLength: item.text.length,
        fingerprint: textFingerprint(item.text),
        preview: textPreview(item.text),
        readyAudioLength: this.queue.readyAudio.length,
        trace: item.sourceItem.trace,
      })
    }
    this.notify()
  }

  private async createAudioReadyItem(sourceItem: QueueItem, generated: { text: string; file: string }) {
    const ready = this.queue.createAudioReadyItem(sourceItem, generated)
    if (this.isStale(sourceItem)) {
      await fs.unlink(generated.file).catch(() => undefined)
      return undefined
    }

    return ready
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

  private async handleRuntimeError(error: unknown) {
    const message = formatError(error)
    this.log.error("runtime error", { error: message })
    this.state.patch({ error: message })

    if (isMissingBinary(error)) {
      const bufferedReadyAudio = this.queue.clearReadyAudio()
      this.state.setEnabled(false)
      this.state.patch({ paused: false })
      this.queue.clearSourceItems()
      if (this.currentGenerate) {
        this.currentGenerate.interrupted = true
        void this.runtime.cancelEpoch(this.currentGenerate.item.epoch)
      }
      if (this.currentPlay) this.currentPlay.interrupted = true
      await this.discardReadyAudio(bufferedReadyAudio)
      this.toastError(`Playback failed. Command not found: ${this.config.audioPlayer}`)
      return
    }

    this.toastError(`Speech failed. ${message}`)
  }

  private toastError(message: string) {
    const now = Date.now()
    if (now - this.lastToastAt < 5000) return
    this.lastToastAt = now
    this.toast({ variant: "error", message })
  }
}
