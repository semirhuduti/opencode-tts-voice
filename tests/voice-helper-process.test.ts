import { describe, expect, it } from "bun:test"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { cleanupServiceState, createServiceState, runtimeIdentity } from "../src/voice-helper-process.js"
import { DEFAULT_CONFIG } from "../src/voice-constants.js"

describe("voice helper service state", () => {
  it("reuses the same runtime when speech speed or voice changes", () => {
    expect(runtimeIdentity({ ...DEFAULT_CONFIG, speed: 0.75 })).toBe(runtimeIdentity({ ...DEFAULT_CONFIG, speed: 1.25 }))
    expect(runtimeIdentity({ ...DEFAULT_CONFIG, voice: "am_adam" })).toBe(runtimeIdentity(DEFAULT_CONFIG))
  })

  it("removes the helper temp directory during cleanup", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-tts-service-test-"))
    const state = createServiceState()
    state.tempDir = Promise.resolve(dir)
    await fs.writeFile(path.join(dir, "segment.wav"), "audio")

    await cleanupServiceState(state)

    await expect(fs.stat(dir)).rejects.toThrow()
  })

  it("waits for active work before disposing the model and cleaning up", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-tts-service-test-"))
    const state = createServiceState()
    state.tempDir = Promise.resolve(dir)
    const events: string[] = []
    let finish!: () => void
    state.work = new Promise<void>((resolve) => { finish = resolve })
    state.runtime = {
      dispose: async () => { events.push("disposed") },
    } as never

    const cleanup = cleanupServiceState(state)
    expect(cleanupServiceState(state)).toBe(cleanup)
    await Promise.resolve()
    expect(state.disposed).toBe(true)
    expect(events).toEqual([])
    finish()
    await cleanup
    expect(events).toEqual(["disposed"])
    await expect(fs.stat(dir)).rejects.toThrow()
  })
})
