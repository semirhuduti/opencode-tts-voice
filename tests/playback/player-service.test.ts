import { describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { buildPlayerArgs, describePlayer, resolveExecutable, toBasePlayer } from "../../src/playback/player-service.js"

describe("player helpers", () => {
  it("uses default args for supported players", () => {
    expect(buildPlayerArgs("/usr/bin/mpv", ["--volume=70"], "file.wav")).toEqual([
      "--no-terminal",
      "--really-quiet",
      "--force-window=no",
      "--audio-display=no",
      "--keep-open=no",
      "--volume=70",
      "file.wav",
    ])
    expect(buildPlayerArgs("ffplay", [], "file.wav")).toEqual(["-nodisp", "-autoexit", "-loglevel", "error", "file.wav"])
    expect(buildPlayerArgs("paplay", [], "file.wav")).toEqual(["file.wav"])
    expect(buildPlayerArgs("aplay", [], "file.wav")).toEqual(["-q", "file.wav"])
  })

  it("normalizes a player path to its backend name", () => {
    expect(toBasePlayer("/usr/local/bin/mpv")).toBe("mpv")
    expect(toBasePlayer("C:\\players\\ffplay.exe")).toBe("ffplay")
  })

  it("describes the resolved player backend", () => {
    expect(describePlayer("/usr/local/bin/mpv")).toEqual({
      audioPlayer: "/usr/local/bin/mpv",
      backend: "mpv",
      player: "mpv",
    })
  })

  it("resolves Windows executable extensions from PATH", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "spoken-replies-player-"))
    const executable = path.join(directory, "ffplay.EXE")
    writeFileSync(executable, "")
    chmodSync(executable, 0o755)

    try {
      expect(
        resolveExecutable("ffplay", { PATH: directory, PATHEXT: ".COM;.EXE;.BAT" }, "win32"),
      ).toBe(executable)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
