import { spawn, type ChildProcess } from "node:child_process"
import * as fsSync from "node:fs"
import * as path from "node:path"
import { PLAYER_CANDIDATES, PLAYER_DEFAULT_ARGS } from "../voice-constants.js"
import type { VoiceConfig } from "../voice-types.js"
import type { TimerRegistry } from "../shared/timer-registry.js"
import { formatError } from "../shared/voice-utils.js"
import type { VoiceLogger } from "../voice-log.js"

export type PlayFileTask = {
  id: number
  interrupted: boolean
  child?: ChildProcess
}

export function toBasePlayer(playerBin: string) {
  return path.basename(playerBin).toLowerCase()
}

export function isMissingBinary(error: unknown): error is NodeJS.ErrnoException {
  return error !== null && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function isExecutable(file: string) {
  try {
    fsSync.accessSync(file, fsSync.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveExecutable(playerBin: string) {
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

export function buildPlayerArgs(playerBin: string, args: string[], file: string) {
  const base = toBasePlayer(playerBin)
  const defaults = PLAYER_DEFAULT_ARGS[base] ?? []
  return [...defaults, ...args, file]
}

export class PlayerService {
  private resolvedPlayer?: string

  constructor(
    private readonly config: VoiceConfig,
    private readonly logger: VoiceLogger,
    private readonly timers: TimerRegistry,
    private readonly onBackend: (backend: string) => void,
  ) {}

  buildArgs(file: string) {
    const playerBin = this.resolvedPlayer ?? this.config.audioPlayer
    return buildPlayerArgs(playerBin, this.config.audioPlayerArgs, file)
  }

  resolvePlayerBin() {
    if (this.resolvedPlayer) return this.resolvedPlayer

    const preferred = this.config.audioPlayer.trim()
    const candidates = preferred && preferred !== "auto" ? [preferred, ...PLAYER_CANDIDATES] : [...PLAYER_CANDIDATES]
    this.logger.info("resolve player start", { preferred, candidates })

    for (const candidate of candidates) {
      const resolved = resolveExecutable(candidate)
      this.logger.info("resolve player candidate", { candidate, resolved: resolved ?? null })
      if (!resolved) continue
      this.resolvedPlayer = resolved
      this.onBackend(toBasePlayer(resolved))
      this.logger.info("resolve player success", { audioPlayer: resolved, backend: toBasePlayer(resolved) })
      return resolved
    }

    throw new Error(`No supported audio player found. Install one of: ${PLAYER_CANDIDATES.join(", ")}`)
  }

  async playFile(file: string, current: PlayFileTask) {
    const playerBin = this.resolvePlayerBin()
    await new Promise<void>((resolve, reject) => {
      const args = this.buildArgs(file)
      this.logger.info("playback spawn", {
        itemID: current.id,
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
        this.logger.error("playback process error", {
          itemID: current.id,
          playerBin,
          error: formatError(error),
          stderr: stderr || undefined,
        })
        done(() => reject(error))
      })

      child.once("exit", (code, signal) => {
        this.logger.info("playback process exit", {
          itemID: current.id,
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

  stopChild(child?: ChildProcess) {
    if (!child || child.killed) return
    this.logger.info("stop child", { pid: child.pid ?? null })
    child.kill("SIGTERM")
    this.timers.setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL")
    }, 250)
  }
}
