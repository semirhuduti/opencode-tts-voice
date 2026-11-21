import { describe, expect, it } from "bun:test"
import { candidateDevices, filterCandidateDevices } from "../src/voice-kokoro.js"

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
