import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"
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

export type ServiceState = {
  runtime?: KokoroRuntime
  runtimeKey: string
  currentConfig?: VoiceConfig
  active?: ActiveRequest
  cancelledRequests: Set<number>
  cancelledEpoch: number
  tempDir?: Promise<string>
  sequence: number
  disposed: boolean
  work: Promise<void>
}

const logger = createLogger("helper-process")

let send: Send = (message) => {
  stdout.write(`${JSON.stringify(message)}\n`)
}

export function createServiceState(): ServiceState {
  return {
    runtimeKey: "",
    cancelledRequests: new Set<number>(),
    cancelledEpoch: -1,
    sequence: 0,
    disposed: false,
    work: Promise.resolve(),
  }
}

const service = createServiceState()

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

function runtimeFor(state: ServiceState, config: VoiceConfig) {
  const key = runtimeIdentity(config)
  state.currentConfig = config
  if (state.runtime && state.runtimeKey === key) return state.runtime

  setTransformersCache(config)
  state.runtimeKey = key
  state.runtime = new KokoroRuntime(config, status, createLogger("kokoro"))
  return state.runtime
}

async function ensureTempDir(state: ServiceState) {
  if (!state.tempDir) {
    state.tempDir = fs.mkdtemp(path.join(os.tmpdir(), "opencode-tts-voice-"))
    logger.info("temp dir requested")
  }
  return state.tempDir
}

async function writeAudioFile(state: ServiceState, audio: Float32Array, sampleRate: number, request: ActiveRequest) {
  const config = state.currentConfig
  if (!config) throw new Error("Missing voice config")

  const dir = await ensureTempDir(state)
  const trimmed = trimSilence(audio, sampleRate, config.trimSilenceThreshold, config.leadingAudioPadMs)
  const file = path.join(dir, `${Date.now()}-${request.id}-${state.sequence++}.wav`)
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

function isCancelled(state: ServiceState, request: ActiveRequest) {
  return request.cancelled || state.cancelledRequests.has(request.id) || request.epoch <= state.cancelledEpoch || state.disposed
}

async function generate(state: ServiceState, input: Extract<HelperRequest, { type: "generate" }>) {
  const request: ActiveRequest = {
    id: input.id,
    epoch: input.epoch,
    cancelled: false,
  }
  state.active = request

  try {
    if (isCancelled(state, request)) {
      send({ type: "cancelled", id: request.id, epoch: request.epoch })
      return
    }

    const tts = runtimeFor(state, input.config)
    for await (const segment of tts.stream(input.text)) {
      if (isCancelled(state, request)) break

      const file = await writeAudioFile(state, segment.audio, segment.sampleRate, request)
      if (isCancelled(state, request)) {
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

    if (isCancelled(state, request)) {
      send({ type: "cancelled", id: request.id, epoch: request.epoch })
      return
    }

    send({ type: "complete", id: request.id, epoch: request.epoch })
  } catch (error) {
    send({ type: "error", id: request.id, epoch: request.epoch, error: formatError(error) })
  } finally {
    if (state.active === request) state.active = undefined
  }
}

export async function cleanupServiceState(state: ServiceState) {
  state.disposed = true
  if (state.active) state.active.cancelled = true
  const dir = state.tempDir
  state.tempDir = undefined
  if (dir) {
    const value = await dir.catch(() => undefined)
    if (value) await fs.rm(value, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function cleanup(exitProcess: boolean) {
  await cleanupServiceState(service)
  if (exitProcess) process.exit(0)
}

export function handleServiceMessage(state: ServiceState, message: HelperRequest) {
  if (message.type === "generate") {
    if (state.disposed) {
      send({ type: "error", id: message.id, epoch: message.epoch, error: "TTS helper is disposed" })
      return
    }
    state.work = state.work.then(() => generate(state, message))
    return
  }

  if (message.type === "cancel") {
    if (typeof message.id === "number") state.cancelledRequests.add(message.id)
    if (typeof message.epoch === "number") state.cancelledEpoch = Math.max(state.cancelledEpoch, message.epoch)
    if (state.active && isCancelled(state, state.active)) state.active.cancelled = true
    return
  }

  void cleanupServiceState(state)
}

async function handle(message: HelperRequest, exitProcess: boolean) {
  if (message.type === "dispose") {
    await cleanup(exitProcess)
    return
  }

  handleServiceMessage(service, message)
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

function isEntrypoint() {
  const entry = process.argv[1]
  if (!entry) return process.env.OPENCODE_TTS_VOICE_HELPER_MODE === "worker"
  return pathToFileURL(path.resolve(entry)).href === import.meta.url
}

if (isEntrypoint()) {
  if (process.env.OPENCODE_TTS_VOICE_HELPER_MODE === "worker") {
    startWorkerMode()
  } else {
    startProcessMode()
  }
}
