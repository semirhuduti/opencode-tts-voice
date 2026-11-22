import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import type { VoiceConfig, VoiceState } from "./voice-types.js"
import type { VoiceLogger } from "./voice-log.js"

type TransformDevice = "auto" | "cpu" | "gpu" | "cuda" | "dml" | "wasm" | "webgpu"

type RuntimeStatus = Partial<Pick<VoiceState, "device" | "error">>

export type LoadedRuntime = {
  dispose(): Promise<void>
  tts: {
    generate(text: string, input: { voice: string; speed: number }): Promise<{ data: Float32Array; sampling_rate: number }>
    stream(
      text: string,
      input: { voice: string; speed: number },
    ): AsyncGenerator<{ text: string; data: Float32Array; sampling_rate: number }, void, void>
  }
  device: string
}

function unique<Value>(values: Value[]) {
  return Array.from(new Set(values))
}

export function candidateDevices(device: VoiceConfig["device"]): TransformDevice[] {
  switch (device) {
    case "cpu":
      return ["cpu"]
    case "wasm":
      // Transformers' Node backend does not accept "wasm" as a device.
      return ["cpu"]
    case "webgpu":
      return ["webgpu", "gpu", "cuda", "dml", "cpu"]
    case "gpu":
      return ["gpu", "cuda", "dml", "webgpu", "cpu"]
    case "cuda":
      return ["cuda", "gpu", "cpu"]
    case "dml":
      return ["dml", "gpu", "cpu"]
    case "auto":
    default:
      return ["gpu", "cuda", "dml", "webgpu", "cpu"]
  }
}

type AvailableProviders = {
  cuda: boolean
  dml: boolean
  webgpu: boolean
}

export function filterCandidateDevices(devices: TransformDevice[], available: AvailableProviders) {
  return unique(devices.filter((device) => {
    if (device === "gpu") return available.cuda || available.dml || available.webgpu
    if (device === "cuda") return available.cuda
    if (device === "dml") return available.dml
    if (device === "webgpu") return available.webgpu
    if (device === "wasm") return false
    return device === "cpu"
  }))
}

function availableProviders(): AvailableProviders {
  const require = createRequire(import.meta.url)
  const runtimeEntry = require.resolve("onnxruntime-node")
  const runtimePackage = path.resolve(path.dirname(runtimeEntry), "..")
  const nativeDirectory = path.join(runtimePackage, "bin", "napi-v3", process.platform, process.arch)

  return {
    cuda: process.platform === "linux" && process.arch === "x64"
      && existsSync(path.join(nativeDirectory, "libonnxruntime_providers_cuda.so")),
    dml: process.platform === "win32" && existsSync(path.join(nativeDirectory, "DirectML.dll")),
    // Transformers' Node backend doesn't support WebGPU.
    webgpu: false,
  }
}

function formatError(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

export async function runWithCpuFallback<Result>(
  runtime: LoadedRuntime,
  operation: (runtime: LoadedRuntime) => Promise<Result>,
  fallback: () => Promise<LoadedRuntime>,
  logger: VoiceLogger,
): Promise<{ runtime: LoadedRuntime; result: Result }> {
  try {
    return { runtime, result: await operation(runtime) }
  } catch (error) {
    if (runtime.device === "cpu") throw error

    logger.warn("accelerated inference failed; retrying on CPU", {
      device: runtime.device,
      error: formatError(error),
    })

    let cpuRuntime: LoadedRuntime
    try {
      cpuRuntime = await fallback()
    } catch (cpuError) {
      throw new Error(
        `Inference failed on ${runtime.device}: ${formatError(error)}. CPU fallback failed: ${formatError(cpuError)}`,
        { cause: cpuError },
      )
    }

    try {
      return { runtime: cpuRuntime, result: await operation(cpuRuntime) }
    } catch (cpuError) {
      throw new Error(
        `Inference failed on ${runtime.device}: ${formatError(error)}. CPU retry failed: ${formatError(cpuError)}`,
        { cause: cpuError },
      )
    }
  }
}

async function prepareOnnxRuntime() {
  const ort = await import("onnxruntime-node")
  ;(ort.env as { logLevel?: string }).logLevel = "error"
}

async function loadKokoroModule() {
  const runtimeSymbol = Symbol.for("onnxruntime")
  const runtimeHost = globalThis as typeof globalThis & { [key: symbol]: unknown }
  const hadRuntimeOverride = runtimeSymbol in runtimeHost
  const runtimeOverride = runtimeHost[runtimeSymbol]

  // Transformers' Node backend selects its supported devices during module
  // initialization. A process-wide runtime override skips that setup, so hide it
  // only while Transformers initializes, then restore it for the rest of OpenCode.
  if (hadRuntimeOverride) delete runtimeHost[runtimeSymbol]
  try {
    return await import("kokoro-js")
  } finally {
    if (hadRuntimeOverride) runtimeHost[runtimeSymbol] = runtimeOverride
  }
}

export class KokoroRuntime {
  private loaded?: LoadedRuntime
  private loading?: Promise<LoadedRuntime>

  constructor(
    private readonly config: VoiceConfig,
    private readonly onStatus: (status: RuntimeStatus) => void,
    private readonly logger: VoiceLogger,
  ) {}

  async generate(text: string) {
    this.logger.info("generate start", {
      textLength: text.length,
      voice: this.config.voice,
      speed: this.config.speed,
    })
    const initialRuntime = await this.load()
    const { runtime, result: audio } = await this.withCpuFallback(initialRuntime, (candidate) =>
      candidate.tts.generate(text, {
        voice: this.config.voice,
        speed: this.config.speed,
      }),
    )
    this.logger.info("generate complete", {
      textLength: text.length,
      sampleRate: audio.sampling_rate,
      samples: audio.data.length,
      device: runtime.device,
    })
    return {
      audio: audio.data,
      sampleRate: audio.sampling_rate,
    }
  }

  async *stream(text: string, speed = this.config.speed, voice = this.config.voice) {
    this.logger.info("stream start", {
      textLength: text.length,
      voice,
      speed,
    })

    let runtime = await this.load()
    let segmentCount = 0
    let totalSamples = 0

    const stream = async function* (candidate: LoadedRuntime) {
      yield* candidate.tts.stream(text, { voice, speed })
    }
    let iterator = stream(runtime)
    try {
      while (true) {
      let next: IteratorResult<{ text: string; data: Float32Array; sampling_rate: number }, void>
      try {
        next = await iterator.next()
      } catch (error) {
        // Once audio has been emitted, retrying the whole input would repeat speech.
        if (runtime.device === "cpu" || segmentCount > 0) throw error
        this.logger.warn("accelerated stream failed; retrying on CPU", {
          device: runtime.device,
          error: formatError(error),
        })
        await iterator.return(undefined).catch(() => undefined)
        runtime = await this.replaceWithCpu(runtime)
        iterator = stream(runtime)
        continue
      }
      if (next.done) break
      const audio = next.value
      segmentCount += 1
      totalSamples += audio.data.length
      this.logger.info("stream segment", {
        textLength: audio.text.length,
        sampleRate: audio.sampling_rate,
        samples: audio.data.length,
        segmentCount,
        device: runtime.device,
      })

      yield {
        text: audio.text,
        audio: audio.data,
        sampleRate: audio.sampling_rate,
      }
      }
    } finally {
      await iterator.return(undefined).catch(() => undefined)
    }

    this.logger.info("stream complete", {
      textLength: text.length,
      segmentCount,
      totalSamples,
      device: runtime.device,
    })
  }

  async dispose() {
    const runtime = this.loaded ?? await this.loading?.catch(() => undefined)
    this.loaded = undefined
    this.loading = undefined
    await runtime?.dispose()
  }

  private async load(deviceOverride?: TransformDevice[]) {
    if (this.loaded) return this.loaded
    if (this.loading) return this.loading

    this.loading = this.create(deviceOverride)
      .then((runtime) => {
        this.loaded = runtime
        this.logger.info("runtime ready", { device: runtime.device })
        return runtime
      })
      .catch((error) => {
        this.loading = undefined
        this.logger.error("runtime load failed", { error: formatError(error) })
        this.onStatus({ device: this.config.device, error: formatError(error) })
        throw error
      })

    return this.loading
  }

  private async withCpuFallback<Result>(
    runtime: LoadedRuntime,
    operation: (runtime: LoadedRuntime) => Promise<Result>,
  ): Promise<{ runtime: LoadedRuntime; result: Result }> {
    return runWithCpuFallback(runtime, operation, () => this.replaceWithCpu(runtime), this.logger)
  }

  private async replaceWithCpu(runtime: LoadedRuntime) {
    if (runtime.device === "cpu") return runtime
    if (this.loaded === runtime) this.loaded = undefined
    this.loading = undefined
    await runtime.dispose().catch((error) => {
      this.logger.warn("failed to dispose accelerated runtime before CPU fallback", { error: formatError(error) })
    })

    this.logger.info("runtime CPU fallback start", { previousDevice: runtime.device })
    return this.load(["cpu"])
  }

  private async create(deviceOverride?: TransformDevice[]): Promise<LoadedRuntime> {
    this.onStatus({ device: "loading", error: undefined })
    this.logger.info("runtime import start", {
      model: this.config.model,
      dtype: this.config.dtype,
      preferredDevice: this.config.device,
    })
    await prepareOnnxRuntime()
    if (this.config.cacheDir) {
      const { env } = await import("@huggingface/transformers")
      env.cacheDir = this.config.cacheDir
    }
    const { KokoroTTS, TextSplitterStream } = await loadKokoroModule()
    type KokoroLoaderOptions = {
      dtype: VoiceConfig["dtype"]
      device: TransformDevice
    }
    const loadKokoro = (device: TransformDevice) =>
      KokoroTTS.from_pretrained(this.config.model, {
        dtype: this.config.dtype,
        device,
      } as KokoroLoaderOptions as Parameters<typeof KokoroTTS.from_pretrained>[1])

    const errors: string[] = []
    const devices = deviceOverride ?? filterCandidateDevices(candidateDevices(this.config.device), availableProviders())
    for (const device of devices) {
      this.logger.info("runtime init attempt", { device })
      try {
        const tts = await loadKokoro(device)
        this.logger.info("runtime init success", { device })
        this.onStatus({ device, error: undefined })
        return {
          dispose: async () => { await tts.model.dispose() },
          tts: {
            generate: async (text, input) => {
              const audio = await tts.generate(text, input as Parameters<typeof tts.generate>[1])
              return {
                data: audio.audio,
                sampling_rate: audio.sampling_rate,
              }
            },
            stream: async function* (text, input) {
              const splitter = new TextSplitterStream()
              splitter.push(text)
              splitter.close()

              for await (const segment of tts.stream(splitter, input as Parameters<typeof tts.stream>[1])) {
                yield {
                  text: segment.text,
                  data: segment.audio.audio,
                  sampling_rate: segment.audio.sampling_rate,
                }
              }
            },
          },
          device,
        }
      } catch (error) {
        errors.push(`${device}: ${formatError(error)}`)
        this.logger.warn("runtime init failed", {
          device,
          error: formatError(error),
        })
      }
    }

    throw new Error(`Failed to initialize Kokoro. ${errors.join("; ")}`)
  }
}
