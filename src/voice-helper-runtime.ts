import { fork, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { HelperRequest, HelperResponse, RuntimeStatus } from "./voice-helper-protocol.js"
import type { VoiceConfig } from "./voice-types.js"
import type { VoiceLogger } from "./voice-log.js"

type PendingRequest = {
  id: number
  epoch: number
  queue: GeneratedSegment[]
  waiters: Array<() => void>
  done: boolean
  error?: Error
}

type GeneratedSegment = {
  text: string
  file: string
}

function formatError(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

export class TtsHelperRuntime {
  private child?: ChildProcess
  private started?: Promise<void>
  private disposed = false
  private nextID = 1
  private pending = new Map<number, PendingRequest>()
  private childStderr = ""

  constructor(
    private readonly config: VoiceConfig,
    private readonly onStatus: (status: RuntimeStatus) => void,
    private readonly logger: VoiceLogger,
  ) {}

  async *stream(text: string, epoch: number): AsyncGenerator<GeneratedSegment, void, void> {
    const request: PendingRequest = {
      id: this.nextID++,
      epoch,
      queue: [],
      waiters: [],
      done: false,
    }
    this.pending.set(request.id, request)

    try {
      await this.send({ type: "generate", id: request.id, epoch, text, config: this.config })

      while (!this.disposed) {
        const item = request.queue.shift()
        if (item) {
          yield item
          continue
        }
        if (request.error) throw request.error
        if (request.done) return
        await this.wait(request)
      }
    } finally {
      this.pending.delete(request.id)
      if (!request.done && !this.disposed) {
        await this.send({ type: "cancel", id: request.id }).catch(() => undefined)
      }
    }
  }

  async cancelEpoch(epoch: number) {
    if (!this.child && !this.started) return
    await this.send({ type: "cancel", epoch }).catch(() => undefined)
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true

    for (const request of this.pending.values()) {
      request.done = true
      this.wake(request)
    }
    this.pending.clear()

    const child = this.child
    this.child = undefined
    if (!child) return
    this.childStderr = ""

    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }

      child.once("exit", done)
      child.send?.({ type: "dispose" } satisfies HelperRequest, (error) => {
        if (error) {
          done()
          return
        }

        setTimeout(() => {
          if (child.exitCode === null && !child.killed) child.kill("SIGTERM")
        }, 250)
      })

      setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill("SIGKILL")
        done()
      }, 1000)
    })
  }

  private async send(message: HelperRequest) {
    if (this.disposed) throw new Error("TTS helper is disposed")
    await this.ensureStarted()
    const child = this.child
    if (!child?.send || !child.connected) throw new Error("TTS helper failed to start")

    await new Promise<void>((resolve, reject) => {
      child.send?.(message, (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  private ensureStarted() {
    if (this.started) return this.started
    this.started = this.start()
    return this.started
  }

  private async start() {
    const helper = fileURLToPath(new URL("./voice-helper-process.js", import.meta.url))
    const child = fork(helper, [], {
      env: {
        ...process.env,
        OPENCODE_TTS_VOICE_LOG_LEVEL: process.env.OPENCODE_TTS_VOICE_HELPER_LOG_LEVEL ?? "silent",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    })
    this.child = child
    this.logger.info("helper child started", { helper, pid: child.pid ?? null })

    child.on("message", (message: HelperResponse) => {
      this.handleResponse(message)
    })

    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.childStderr = `${this.childStderr}${String(chunk)}`.slice(-4000)
    })

    child.on("error", (error) => {
      this.logger.error("helper child error", {
        error: formatError(error),
        stderr: this.childStderr || undefined,
      })
      this.failAll(error)
      this.child = undefined
      this.started = undefined
    })

    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = undefined
      this.started = undefined
      if (this.disposed) return
      this.logger.error("helper child exited", {
        code,
        signal,
        stderr: this.childStderr.trim() || undefined,
      })
      this.failAll(new Error(`TTS helper exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`))
    })
  }

  private handleResponse(message: HelperResponse) {
    if (message.type === "status") {
      this.onStatus(message.status)
      return
    }

    if (message.type === "error") {
      const error = new Error(message.error)
      if (typeof message.id !== "number") {
        this.failAll(error)
        return
      }
      const request = this.pending.get(message.id)
      if (!request) return
      request.error = error
      request.done = true
      this.wake(request)
      return
    }

    const request = this.pending.get(message.id)
    if (!request || request.epoch !== message.epoch) return

    if (message.type === "segment") {
      this.logger.info("helper segment received", {
        requestID: message.id,
        epoch: message.epoch,
        textLength: message.text.length,
        file: message.file,
      })
      request.queue.push({ text: message.text, file: message.file })
      this.wake(request)
      return
    }

    request.done = true
    this.wake(request)
  }

  private failAll(error: unknown) {
    const next = error instanceof Error ? error : new Error(formatError(error))
    this.logger.error("helper failed", { error: next.message })
    for (const request of this.pending.values()) {
      request.error = next
      request.done = true
      this.wake(request)
    }
  }

  private wait(request: PendingRequest) {
    return new Promise<void>((resolve) => {
      request.waiters.push(resolve)
    })
  }

  private wake(request: PendingRequest) {
    const waiters = request.waiters.splice(0)
    for (const waiter of waiters) waiter()
  }
}
