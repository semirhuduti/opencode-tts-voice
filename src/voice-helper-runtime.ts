import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
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
  private child?: ChildProcessWithoutNullStreams
  private started?: Promise<void>
  private disposed = false
  private nextID = 1
  private pending = new Map<number, PendingRequest>()
  private stderr = ""

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

    if (!child.killed) {
      child.stdin.write(`${JSON.stringify({ type: "dispose" } satisfies HelperRequest)}\n`)
      child.stdin.end()
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM")
        resolve()
      }, 1000)
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private async send(message: HelperRequest) {
    if (this.disposed) throw new Error("TTS helper is disposed")
    await this.ensureStarted()
    const child = this.child
    if (!child) throw new Error("TTS helper failed to start")
    if (!child.stdin.write(`${JSON.stringify(message)}\n`)) {
      await new Promise<void>((resolve) => child.stdin.once("drain", resolve))
    }
  }

  private ensureStarted() {
    if (this.started) return this.started
    this.started = this.start()
    return this.started
  }

  private async start() {
    const helper = fileURLToPath(new URL("./voice-helper-process.js", import.meta.url))
    const child = spawn(process.execPath, [helper], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Helper stdout is reserved for protocol messages.
        OPENCODE_TTS_VOICE_LOG_LEVEL: process.env.OPENCODE_TTS_VOICE_HELPER_LOG_LEVEL ?? "silent",
      },
    })
    this.child = child

    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-4000)
    })

    child.once("error", (error) => {
      this.failAll(error)
    })

    child.once("exit", (code, signal) => {
      if (this.disposed) return
      const suffix = this.stderr.trim() ? `. ${this.stderr.trim()}` : ""
      this.failAll(new Error(`TTS helper exited with code ${code ?? "unknown"}${signal ? ` signal ${signal}` : ""}${suffix}`))
      this.child = undefined
      this.started = undefined
    })

    void this.readResponses(child)
  }

  private async readResponses(child: ChildProcessWithoutNullStreams) {
    const lines = createInterface({ input: child.stdout })
    try {
      for await (const line of lines) {
        const text = line.trim()
        if (!text) continue
        this.handleResponse(JSON.parse(text) as HelperResponse)
      }
    } catch (error) {
      if (!this.disposed) this.failAll(error)
    }
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
