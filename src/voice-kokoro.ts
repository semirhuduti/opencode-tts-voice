import * as os from "node:os"
import type { VoiceConfig, VoiceState } from "./voice-types.js"
import type { VoiceLogger } from "./voice-log.js"

type TransformDevice = "auto" | "cpu" | "gpu" | "cuda" | "dml" | "wasm" | "webgpu"

type RuntimeStatus = Partial<Pick<VoiceState, "device" | "error">>

const ORT_SYMBOL = Symbol.for("onnxruntime")
const SESSION_OPTIONS_SYMBOL = Symbol.for("opencode-tts-voice.session-options")
const SESSION_PATCH_SYMBOL = Symbol.for("opencode-tts-voice.session-options-patched")

type LoadedRuntime = {
  tts: {
    generate(text: string, input: { voice: string; speed: number }): Promise<{ data: Float32Array; sampling_rate: number }>
    stream(
      text: string,
      input: { voice: string; speed: number },
    ): AsyncGenerator<{ text: string; data: Float32Array; sampling_rate: number }, void, void>
  }
  device: string
}

type OnnxSessionOptions = {
  intraOpNumThreads: number
  interOpNumThreads: number
  executionMode: "sequential"
}

type TransformersModule = {
  env: {
    cacheDir?: string
    backends?: {
      onnx?: {
        wasm?: {
          numThreads?: number
        }
      }
    }
  }
  StyleTextToSpeech2Model: {
    from_pretrained: (model: string, options?: Record<string, unknown>) => Promise<unknown>
  }
}

function unique<Value>(values: Value[]) {
  return Array.from(new Set(values))
}

function candidateDevices(device: VoiceConfig["device"]): TransformDevice[] {
  switch (device) {
    case "cpu":
      return ["cpu", "wasm"]
    case "wasm":
      return ["wasm", "cpu"]
    case "webgpu":
      return ["webgpu", "gpu", "cuda", "dml", "cpu", "wasm"]
    case "gpu":
      return ["gpu", "cuda", "dml", "webgpu", "cpu", "wasm"]
    case "cuda":
      return ["cuda", "gpu", "cpu", "wasm"]
    case "dml":
      return ["dml", "gpu", "cpu", "wasm"]
    case "auto":
    default:
      return ["gpu", "cuda", "dml", "webgpu", "cpu", "wasm"]
  }
}

function formatError(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function availableCpuCount() {
  return Math.max(1, os.availableParallelism?.() ?? os.cpus().length ?? 1)
}

function createSessionOptions(config: VoiceConfig) {
  const cpuCount = availableCpuCount()
  const totalThreads = Math.max(1, Math.floor((cpuCount * config.cpuLimitPercent) / 100))
  const generationThreads = Math.max(1, Math.floor(totalThreads / config.cpuLimitConcurrency))
  const sessionOptions: OnnxSessionOptions = {
    intraOpNumThreads: generationThreads,
    interOpNumThreads: 1,
    executionMode: "sequential",
  }

  return {
    cpuCount,
    totalThreads,
    generationThreads,
    sessionOptions,
  }
}

function patchStyleTextToSpeechLoader(transformers: TransformersModule) {
  const globals = globalThis as Record<PropertyKey, unknown>
  if (globals[SESSION_PATCH_SYMBOL]) return

  // kokoro-js does not expose Transformers.js session options, so patch the model loader before Kokoro imports it.
  const model = transformers.StyleTextToSpeech2Model
  const original = model.from_pretrained.bind(model)
  model.from_pretrained = (async (modelID: string, options: Record<string, unknown> = {}) => {
    const sessionOptions = globals[SESSION_OPTIONS_SYMBOL]
    const existing = options.session_options
    return original(modelID, {
      ...options,
      session_options: {
        ...(isRecord(existing) ? existing : {}),
        ...(isRecord(sessionOptions) ? sessionOptions : {}),
      },
    })
  }) as typeof model.from_pretrained

  globals[SESSION_PATCH_SYMBOL] = true
}

async function prepareOnnxRuntime() {
  const ort = await import("onnxruntime-node")
  ;(ort.env as { logLevel?: string }).logLevel = "error"
  ;(globalThis as Record<PropertyKey, unknown>)[ORT_SYMBOL] = ort
}

async function loadKokoroModule() {
  return import("kokoro-js")
}

async function configureTransformers(config: VoiceConfig, logger: VoiceLogger) {
  const transformers = (await import("@huggingface/transformers")) as unknown as TransformersModule
  const limits = createSessionOptions(config)
  ;(globalThis as Record<PropertyKey, unknown>)[SESSION_OPTIONS_SYMBOL] = limits.sessionOptions
  transformers.env.backends?.onnx?.wasm && (transformers.env.backends.onnx.wasm.numThreads = limits.generationThreads)
  if (config.cacheDir) transformers.env.cacheDir = config.cacheDir
  patchStyleTextToSpeechLoader(transformers)
  logger.info("resource limits configured", {
    cpuCount: limits.cpuCount,
    cpuLimitPercent: config.cpuLimitPercent,
    cpuLimitConcurrency: config.cpuLimitConcurrency,
    totalThreads: limits.totalThreads,
    generationThreads: limits.generationThreads,
  })
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
    const runtime = await this.load()
    const audio = await runtime.tts.generate(text, {
      voice: this.config.voice,
      speed: this.config.speed,
    })
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

  async *stream(text: string) {
    this.logger.info("stream start", {
      textLength: text.length,
      voice: this.config.voice,
      speed: this.config.speed,
    })

    const runtime = await this.load()
    let segmentCount = 0
    let totalSamples = 0

    for await (const audio of runtime.tts.stream(text, {
      voice: this.config.voice,
      speed: this.config.speed,
    })) {
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

    this.logger.info("stream complete", {
      textLength: text.length,
      segmentCount,
      totalSamples,
      device: runtime.device,
    })
  }

  private async load() {
    if (this.loaded) return this.loaded
    if (this.loading) return this.loading

    this.loading = this.create()
      .then((runtime) => {
        this.loaded = runtime
        this.logger.info("runtime ready", { device: runtime.device })
        return runtime
      })
      .catch((error) => {
        this.loading = undefined
        this.logger.error("runtime load failed", { error: formatError(error) })
        this.onStatus({ error: formatError(error) })
        throw error
      })

    return this.loading
  }

  private async create(): Promise<LoadedRuntime> {
    this.logger.info("runtime import start", {
      model: this.config.model,
      dtype: this.config.dtype,
      preferredDevice: this.config.device,
      cpuLimitPercent: this.config.cpuLimitPercent,
      cpuLimitConcurrency: this.config.cpuLimitConcurrency,
    })
    await prepareOnnxRuntime()
    await configureTransformers(this.config, this.logger)
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

    this.onStatus({ device: "loading", error: undefined })

    let lastError: unknown
    for (const device of unique(candidateDevices(this.config.device))) {
      this.logger.info("runtime init attempt", { device })
      try {
        const tts = await loadKokoro(device)
        this.logger.info("runtime init success", { device })
        this.onStatus({ device, error: undefined })
        return {
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
        lastError = error
        this.logger.warn("runtime init failed", {
          device,
          error: formatError(error),
        })
      }
    }

    throw new Error(`Failed to initialize Kokoro. ${formatError(lastError)}`)
  }
}
