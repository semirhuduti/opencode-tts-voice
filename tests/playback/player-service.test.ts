import { describe, expect, it } from "bun:test"
import { buildPlayerArgs, toBasePlayer } from "../../src/playback/player-service.js"

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
  })
})
