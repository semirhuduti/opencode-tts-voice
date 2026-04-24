import type { VoiceConfig, VoiceState } from "./voice-types.js"

type TransformDevice = "auto" | "cpu" | "gpu" | "cuda" | "dml" | "wasm" | "webgpu"

type RuntimeStatus = Partial<Pick<VoiceState, "device" | "error">>

type LoadedRuntime = {
  tts: {
    generate(text: string, input: { voice: string; speed: number }): Promise<{ data: Float32Array; sampling_rate: number }>
  }
  device: string
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

export class KokoroRuntime {
  private loaded?: LoadedRuntime
  private loading?: Promise<LoadedRuntime>

  constructor(
    private readonly config: VoiceConfig,
    private readonly onStatus: (status: RuntimeStatus) => void,
  ) {}

  async generate(text: string) {
    const runtime = await this.load()
    const audio = await runtime.tts.generate(text, {
      voice: this.config.voice,
      speed: this.config.speed,
    })
    return {
      audio: audio.data,
      sampleRate: audio.sampling_rate,
    }
  }

  private async load() {
    if (this.loaded) return this.loaded
    if (this.loading) return this.loading

    this.loading = this.create()
      .then((runtime) => {
        this.loaded = runtime
        return runtime
      })
      .catch((error) => {
        this.loading = undefined
        this.onStatus({ error: formatError(error) })
        throw error
      })

    return this.loading
  }

  private async create(): Promise<LoadedRuntime> {
    const { KokoroTTS } = await import("kokoro-js")
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
      try {
        const tts = await loadKokoro(device)
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
          },
          device,
        }
      } catch (error) {
        lastError = error
      }
    }

    throw new Error(`Failed to initialize Kokoro. ${formatError(lastError)}`)
  }
}
