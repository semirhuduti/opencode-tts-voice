import { describe, expect, it } from "bun:test"
import { audioPlayerInstallHint, nodeRuntimeInstallHint } from "../src/platform-help.js"

describe("platform installation hints", () => {
  it("shows Windows commands for missing Node and audio player", () => {
    expect(nodeRuntimeInstallHint("win32")).toContain("winget install --id OpenJS.NodeJS.LTS --exact")
    expect(audioPlayerInstallHint("win32")).toContain("winget install --id Gyan.FFmpeg -e")
  })

  it("shows platform-appropriate audio player instructions", () => {
    expect(audioPlayerInstallHint("darwin")).toContain("brew install ffmpeg")
    expect(audioPlayerInstallHint("linux")).toContain("sudo apt install ffmpeg")
  })
})
