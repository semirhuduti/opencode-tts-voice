import { describe, expect, it } from "bun:test"
import { candidateDevices, filterCandidateDevices, runWithCpuFallback, type LoadedRuntime } from "../src/voice-kokoro.js"

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

function runtime(device: string, generate: (text: string) => Promise<string>): LoadedRuntime {
  return {
    device,
    dispose: async () => {},
    tts: {
      generate: async (text) => ({ data: new Float32Array([Number(await generate(text))]), sampling_rate: 24000 }),
      stream: async function* (text) {
        yield { text, data: new Float32Array([Number(await generate(text))]), sampling_rate: 24000 }
      },
    },
  }
}

describe("candidateDevices", () => {
  it("tries GPU backends before CPU in automatic mode without unsupported WASM", () => {
    expect(candidateDevices("auto")).toEqual(["gpu", "cuda", "dml", "webgpu", "cpu"])
  })

  it("uses CPU directly for CPU preference", () => {
    expect(candidateDevices("cpu")).toEqual(["cpu"])
  })

  it("falls back to CPU for legacy WASM preference", () => {
    expect(candidateDevices("wasm")).toEqual(["cpu"])
  })

  it("skips unavailable accelerators so their failed initialization cannot break CPU fallback", () => {
    expect(filterCandidateDevices(candidateDevices("auto"), {
      cuda: false,
      dml: false,
      webgpu: false,
    })).toEqual(["cpu"])
  })

  it("keeps CUDA candidates when the CUDA provider library is installed", () => {
    expect(filterCandidateDevices(candidateDevices("auto"), {
      cuda: true,
      dml: false,
      webgpu: false,
    })).toEqual(["gpu", "cuda", "cpu"])
  })
})

describe("runWithCpuFallback", () => {
  it("retries failed accelerated inference on CPU", async () => {
    const gpu = runtime("dml", async () => {
      throw new Error("DirectML ConvTranspose failed")
    })
    const cpu = runtime("cpu", async () => "24000")

    const result = await runWithCpuFallback(
      gpu,
      async (candidate) => candidate.tts.generate("hello", { voice: "af_heart", speed: 1 }),
      async () => cpu,
      logger,
    )

    expect(result.runtime.device).toBe("cpu")
    expect(result.result.data[0]).toBe(24000)
  })

  it("does not retry again when CPU inference fails", async () => {
    const cpu = runtime("cpu", async () => {
      throw new Error("CPU inference failed")
    })
    let fallbackCalls = 0

    await expect(
      runWithCpuFallback(cpu, () => cpu.tts.generate("hello", { voice: "af_heart", speed: 1 }), async () => {
        fallbackCalls++
        return cpu
      }, logger),
    ).rejects.toThrow("CPU inference failed")
    expect(fallbackCalls).toBe(0)
  })
})
