import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline"
import { trimSilence, wavFromFloat32 } from "./voice-audio.js"
import type { HelperRequest, HelperResponse, RuntimeStatus } from "./voice-helper-protocol.js"
import { KokoroRuntime } from "./voice-kokoro.js"
import { createLogger } from "./voice-log.js"
import type { VoiceConfig } from "./voice-types.js"

type ActiveRequest = {
  id: number
  epoch: number
  cancelled: boolean
}

type Send = (message: HelperResponse) => void

const logger = createLogger("helper-process")

let runtime: KokoroRuntime | undefined
let runtimeKey = ""
let currentConfig: VoiceConfig | undefined
let active: ActiveRequest | undefined
const cancelledRequests = new Set<number>()
let cancelledEpoch = -1
let tempDir: Promise<string> | undefined
let sequence = 0
let disposed = false
let work: Promise<void> = Promise.resolve()
let send: Send = (message) => {
  stdout.write(`${JSON.stringify(message)}\n`)
}

function formatError(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function runtimeIdentity(config: VoiceConfig) {
  return JSON.stringify({
    model: config.model,
    dtype: config.dtype,
    device: config.device,
    voice: config.voice,
    speed: config.speed,
    cacheDir: config.cacheDir,
    trimSilenceThreshold: config.trimSilenceThreshold,
    leadingAudioPadMs: config.leadingAudioPadMs,
  })
}

function setTransformersCache(config: VoiceConfig) {
  if (!config.cacheDir) return
  process.env.TRANSFORMERS_CACHE = config.cacheDir
  process.env.HF_HOME ??= config.cacheDir
}

function status(status: RuntimeStatus) {
  send({ type: "status", status })
}

function runtimeFor(config: VoiceConfig) {
  const key = runtimeIdentity(config)
  currentConfig = config
  if (runtime && runtimeKey === key) return runtime

  setTransformersCache(config)
  runtimeKey = key
  runtime = new KokoroRuntime(config, status, createLogger("kokoro"))
  return runtime
}

async function ensureTempDir() {
  if (!tempDir) {
    tempDir = fs.mkdtemp(path.join(os.tmpdir(), "opencode-tts-voice-"))
    logger.info("temp dir requested")
  }
  return tempDir
}

async function writeAudioFile(audio: Float32Array, sampleRate: number, request: ActiveRequest) {
  const config = currentConfig
  if (!config) throw new Error("Missing voice config")

  const dir = await ensureTempDir()
  const trimmed = trimSilence(audio, sampleRate, config.trimSilenceThreshold, config.leadingAudioPadMs)
  const file = path.join(dir, `${Date.now()}-${request.id}-${sequence++}.wav`)
  await fs.writeFile(file, wavFromFloat32(trimmed, sampleRate))
  logger.info("audio file written", {
    file,
    requestID: request.id,
    sampleRate,
    inputSamples: audio.length,
    outputSamples: trimmed.length,
  })
  return file
}

function isCancelled(request: ActiveRequest) {
  return request.cancelled || cancelledRequests.has(request.id) || request.epoch <= cancelledEpoch || disposed
}

async function generate(input: Extract<HelperRequest, { type: "generate" }>) {
  const request: ActiveRequest = {
    id: input.id,
    epoch: input.epoch,
    cancelled: false,
  }
  active = request

  try {
    const tts = runtimeFor(input.config)
    for await (const segment of tts.stream(input.text)) {
      if (isCancelled(request)) break

      const file = await writeAudioFile(segment.audio, segment.sampleRate, request)
      if (isCancelled(request)) {
        await fs.unlink(file).catch(() => undefined)
        break
      }

      send({
        type: "segment",
        id: request.id,
        epoch: request.epoch,
        text: segment.text,
        file,
      })
    }

    if (isCancelled(request)) {
      send({ type: "cancelled", id: request.id, epoch: request.epoch })
      return
    }

    send({ type: "complete", id: request.id, epoch: request.epoch })
  } catch (error) {
    send({ type: "error", id: request.id, epoch: request.epoch, error: formatError(error) })
  } finally {
    if (active === request) active = undefined
  }
}

async function cleanup(exitProcess: boolean) {
  disposed = true
  if (active) active.cancelled = true
  const dir = tempDir
  tempDir = undefined
  if (dir) {
    const value = await dir.catch(() => undefined)
    if (value) await fs.rm(value, { recursive: true, force: true }).catch(() => undefined)
  }
  if (exitProcess) process.exit(0)
}

async function handle(message: HelperRequest, exitProcess: boolean) {
  if (message.type === "generate") {
    work = work.then(() => generate(message))
    return
  }

  if (message.type === "cancel") {
    if (typeof message.id === "number") cancelledRequests.add(message.id)
    if (typeof message.epoch === "number") cancelledEpoch = Math.max(cancelledEpoch, message.epoch)
    if (active && isCancelled(active)) active.cancelled = true
    return
  }

  await cleanup(exitProcess)
}

async function main() {
  const lines = createInterface({ input: stdin })
  for await (const line of lines) {
    const text = line.trim()
    if (!text) continue

    try {
      await handle(JSON.parse(text) as HelperRequest, true)
    } catch (error) {
      send({ type: "error", error: formatError(error) })
    }
  }

  await cleanup(false)
}

function startWorkerMode() {
  logger.info("helper worker mode started")
  send = (message) => {
    postMessage(message)
  }

  addEventListener("message", (event: MessageEvent<HelperRequest>) => {
    void handle(event.data, false).catch((error) => {
      send({ type: "error", error: formatError(error) })
    })
  })
}

function startProcessMode() {
  if (process.env.OPENCODE_TTS_VOICE_HELPER_MODE === "worker") {
    throw new Error("Refusing to start helper process mode while worker mode is requested")
  }

  logger.info("helper process mode started")
  process.once("SIGTERM", () => {
    void cleanup(true)
  })

  void main().catch((error) => {
    send({ type: "error", error: formatError(error) })
    process.exit(1)
  })
}

if (process.env.OPENCODE_TTS_VOICE_HELPER_MODE === "worker") {
  startWorkerMode()
} else {
  startProcessMode()
}
