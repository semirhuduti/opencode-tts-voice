import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import * as fsSync from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline"
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

function isExecutable(file: string) {
  try {
    fsSync.accessSync(file, fsSync.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv) {
  if (command.includes(path.sep)) return isExecutable(command) ? command : undefined

  const envPath = env.PATH ?? ""
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, command)
    if (isExecutable(candidate)) return candidate
  }

  return undefined
}

function isJavaScriptRuntime(command: string) {
  const base = path.basename(command).toLowerCase().replace(/\.exe$/, "")
  return base === "node" || base === "nodejs" || base === "bun"
}

function resolveDefaultRuntime(execPath: string, env: NodeJS.ProcessEnv) {
  if (isJavaScriptRuntime(execPath)) return execPath

  const bunInstall = env.BUN_INSTALL ? path.join(env.BUN_INSTALL, "bin", "bun") : undefined
  if (bunInstall && isExecutable(bunInstall)) return bunInstall

  const runtime = resolveExecutable("bun", env) ?? resolveExecutable("node", env) ?? resolveExecutable("nodejs", env)
  if (runtime) return runtime

  throw new Error("No Node or Bun executable found for the TTS helper service. Install one, or set ttsServiceCommand.")
}

export function resolveHelperServiceLaunch(
  config: Pick<VoiceConfig, "ttsServiceCommand" | "ttsServiceArgs">,
  helper: string,
  execPath = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
) {
  let runtime: string | undefined
  const defaultRuntime = () => {
    runtime ??= resolveDefaultRuntime(execPath, env)
    return runtime
  }
  const replacePlaceholder = (value: string) => {
    if (value === "{helper}") return helper
    if (value === "{runtime}" || value === "{node}") return defaultRuntime()
    return value
  }

  const command = config.ttsServiceCommand ? replacePlaceholder(config.ttsServiceCommand) : defaultRuntime()
  const args = (config.ttsServiceCommand ? (config.ttsServiceArgs ?? ["{helper}"]) : ["{helper}"]).map(
    replacePlaceholder,
  )
  return { command, args }
}

export class TtsHelperRuntime {
  private child?: ChildProcessWithoutNullStreams
  private started?: Promise<void>
  private disposed = false
  private nextID = 1
  private pending = new Map<number, PendingRequest>()

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

    this.write(child, { type: "dispose" })
    child.stdin.end()
    setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM")
    }, 1000).unref()
  }

  private async send(message: HelperRequest) {
    if (this.disposed) throw new Error("TTS helper is disposed")
    await this.ensureStarted()
    const child = this.child
    if (!child) throw new Error("TTS helper failed to start")
    this.write(child, message)
  }

  private write(child: ChildProcessWithoutNullStreams, message: HelperRequest) {
    if (!child.stdin.writable) throw new Error("TTS helper stdin is closed")
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private ensureStarted() {
    if (this.started) return this.started
    this.started = this.start()
    return this.started
  }

  private async start() {
    const helper = fileURLToPath(new URL("./voice-helper-process.js", import.meta.url))
    const { command, args } = resolveHelperServiceLaunch(this.config, helper)
    const child = spawn(command, args, {
      env: {
        ...process.env,
        OPENCODE_TTS_VOICE_HELPER_MODE: "process",
        OPENCODE_TTS_VOICE_LOG_LEVEL: process.env.OPENCODE_TTS_VOICE_HELPER_LOG_LEVEL ?? "silent",
        OPENCODE_TTS_VOICE_CONSOLE_LOG: "false",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.child = child
    this.logger.info("helper service started", { command, args, helper })

    let stderr = ""
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2000)
    })

    createInterface({ input: child.stdout }).on("line", (line) => {
      const text = line.trim()
      if (!text) return

      try {
        this.handleResponse(JSON.parse(text) as HelperResponse)
      } catch (error) {
        this.failAll(new Error(`Invalid TTS helper response: ${formatError(error)}`))
        child.kill("SIGTERM")
      }
    })

    child.once("error", (error) => {
      this.failAll(error)
      this.child = undefined
      this.started = undefined
    })

    child.once("exit", (code, signal) => {
      this.logger.info("helper service exited", {
        code,
        signal,
        stderr: stderr.trim() || undefined,
      })
      if (this.child === child) this.child = undefined
      this.started = undefined
      if (!this.disposed && (code !== 0 || this.pending.size > 0)) {
        this.failAll(new Error(`TTS helper exited with code ${code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`))
      }
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
