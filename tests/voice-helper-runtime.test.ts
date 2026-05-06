import { afterEach, describe, expect, it } from "bun:test"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { DEFAULT_CONFIG } from "../src/voice-constants.js"
import { resolveHelperServiceLaunch, TtsHelperRuntime } from "../src/voice-helper-runtime.js"
import { createLogger } from "../src/voice-log.js"

const tempDirs: string[] = []

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-tts-runtime-test-"))
  tempDirs.push(dir)
  return dir
}

async function writeServiceScript(source: string) {
  const dir = await tempDir()
  const file = path.join(dir, "service.mjs")
  await fs.writeFile(file, source)
  return file
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  }
})

describe("TtsHelperRuntime service process", () => {
  it("uses a JavaScript runtime instead of an OpenCode execPath for the default service", () => {
    expect(
      resolveHelperServiceLaunch(
        DEFAULT_CONFIG,
        "/plugin/dist/voice-helper-process.js",
        "/usr/bin/opencode",
        { PATH: path.dirname(process.execPath) },
      ),
    ).toEqual({
      command: process.execPath,
      args: ["/plugin/dist/voice-helper-process.js"],
    })
  })

  it("expands runtime and helper placeholders for wrapper commands", () => {
    expect(
      resolveHelperServiceLaunch(
        { ttsServiceCommand: "nice", ttsServiceArgs: ["-n", "10", "{runtime}", "{helper}"] },
        "/plugin/dist/voice-helper-process.js",
        "/usr/bin/opencode",
        { PATH: path.dirname(process.execPath) },
      ),
    ).toEqual({
      command: "nice",
      args: ["-n", "10", process.execPath, "/plugin/dist/voice-helper-process.js"],
    })
  })

  it("streams segments from a child process over newline JSON", async () => {
    const audioDir = await tempDir()
    const service = await writeServiceScript(`
      import { createInterface } from "node:readline";
      const audioFile = ${JSON.stringify(path.join(audioDir, "segment.wav"))};
      for await (const line of createInterface({ input: process.stdin })) {
        const message = JSON.parse(line);
        if (message.type === "generate") {
          process.stdout.write(JSON.stringify({ type: "status", status: { device: "cpu" } }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "segment", id: message.id, epoch: message.epoch, text: "Hello", file: audioFile }) + "\\n");
          process.stdout.write(JSON.stringify({ type: "complete", id: message.id, epoch: message.epoch }) + "\\n");
        }
        if (message.type === "dispose") process.exit(0);
      }
    `)
    const statuses: unknown[] = []
    const runtime = new TtsHelperRuntime(
      { ...DEFAULT_CONFIG, ttsServiceCommand: process.execPath, ttsServiceArgs: [service] },
      (status) => statuses.push(status),
      createLogger("test-helper"),
    )

    const segments = []
    for await (const segment of runtime.stream("Hello", 1)) segments.push(segment)
    await runtime.dispose()

    expect(statuses).toEqual([{ device: "cpu" }])
    expect(segments).toEqual([{ text: "Hello", file: path.join(audioDir, "segment.wav") }])
  })

  it("fails pending streams when the service crashes", async () => {
    const service = await writeServiceScript(`process.exit(42);`)
    const runtime = new TtsHelperRuntime(
      { ...DEFAULT_CONFIG, ttsServiceCommand: process.execPath, ttsServiceArgs: [service] },
      () => undefined,
      createLogger("test-helper"),
    )

    await expect(async () => {
      for await (const _segment of runtime.stream("Hello", 1)) {
      }
    }).toThrow(/TTS helper exited with code 42/)
    await runtime.dispose()
  })
})
