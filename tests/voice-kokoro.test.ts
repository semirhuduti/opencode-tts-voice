import { describe, expect, it } from "bun:test"
import { candidateDevices } from "../src/voice-kokoro.js"

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
})
