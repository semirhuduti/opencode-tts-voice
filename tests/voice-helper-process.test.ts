import { describe, expect, it } from "bun:test"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { cleanupServiceState, createServiceState } from "../src/voice-helper-process.js"

describe("voice helper service state", () => {
  it("removes the helper temp directory during cleanup", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-tts-service-test-"))
    const state = createServiceState()
    state.tempDir = Promise.resolve(dir)
    await fs.writeFile(path.join(dir, "segment.wav"), "audio")

    await cleanupServiceState(state)

    await expect(fs.stat(dir)).rejects.toThrow()
  })
})
