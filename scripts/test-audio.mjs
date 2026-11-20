import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { once } from "node:events"
import { readFile, access } from "node:fs/promises"
import { createInterface } from "node:readline"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PlayerService } from "../src/playback/player-service.ts"
import { TimerRegistry } from "../src/shared/timer-registry.ts"
import { createLogger } from "../src/voice-log.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const helper = path.join(root, "dist", "voice-helper-process.js")
const timeoutMs = 5 * 60 * 1000
const require = createRequire(import.meta.url)
const sharp = require("sharp")
if (sharp.versions?.sharp !== "0.35.5") throw new Error(`Expected sharp 0.35.5, found ${sharp.versions?.sharp ?? "unknown"}`)

try {
  await access(helper)
} catch {
  throw new Error("Built helper not found. Run npm run build before this test.")
}

const { DEFAULT_CONFIG } = await import("../src/voice-constants.ts")
const config = { ...DEFAULT_CONFIG, device: "cpu" }
const runtime = process.env.OPENCODE_TTS_TEST_NODE || "node"
const child = spawn(runtime, [helper], {
  env: { ...process.env, OPENCODE_TTS_VOICE_HELPER_MODE: "process", OPENCODE_TTS_VOICE_LOG_LEVEL: "silent" },
  stdio: ["pipe", "pipe", "pipe"],
})
child.stdin.on("error", () => {})
let stderr = ""
child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4000) })
const lines = createInterface({ input: child.stdout })
let timedOut = false
const timeout = setTimeout(() => {
  timedOut = true
  child.kill("SIGKILL")
}, timeoutMs)
const exited = once(child, "close")
void exited.catch(() => undefined)
let segments = 0
let complete = false
let failure

try {
  child.stdin.write(`${JSON.stringify({ type: "generate", id: 1, epoch: 1, text: "This is a voice test.", config })}\n`)
  for await (const line of lines) {
    const message = JSON.parse(line)
    if (message.type === "error") throw new Error(message.error)
    if (message.type === "segment") {
      const audio = await readFile(message.file)
      if (audio.length <= 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error("Helper returned invalid or empty WAV audio")
      }
      if (process.env.OPENCODE_TTS_TEST_PLAY === "1") {
        const timers = new TimerRegistry()
        try {
          const player = new PlayerService(config, createLogger("audio-test"), timers, () => {})
          await player.playFile(message.file, { id: segments + 1, interrupted: false })
        } finally {
          timers.dispose()
        }
      }
      segments++
    }
    if (message.type === "cancelled") throw new Error("Speech generation was cancelled")
    if (message.type === "complete") {
      complete = true
      break
    }
  }
  if (!complete || segments === 0) {
    await exited
    throw new Error(`Speech generation did not complete: ${timedOut ? "timed out after 5 minutes" : stderr || "no audio returned"}`)
  }
  clearTimeout(timeout)
} catch (error) {
  failure = error
  throw error
} finally {
  clearTimeout(timeout)
  lines.close()
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin.end(`${JSON.stringify({ type: "dispose" })}\n`)
    const kill = setTimeout(() => child.kill("SIGKILL"), 10000)
    try {
      const [code, signal] = await exited.catch((error) => {
        if (!failure) throw error
        return [undefined, undefined]
      })
      if (!failure && (code !== 0 || signal)) throw new Error(`Helper exited unexpectedly: ${code ?? signal}${stderr ? `: ${stderr}` : ""}`)
    } finally {
      clearTimeout(kill)
    }
  } else {
    const result = await exited.catch((error) => {
      if (!failure) throw error
      return undefined
    })
    if (!failure && result && (result[0] !== 0 || result[1])) {
      throw new Error(`Helper exited unexpectedly: ${result[0] ?? result[1]}${stderr ? `: ${stderr}` : ""}`)
    }
  }
}
console.log(`Speech generation passed: ${segments} WAV segment(s) generated on CPU.`)
