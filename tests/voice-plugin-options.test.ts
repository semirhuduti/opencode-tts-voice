import { describe, expect, it } from "bun:test"
import { findVoicePluginOptions, mergeVoicePluginOptions } from "../src/voice-plugin-options.js"

const packageName = "@scotteza/opencode-spoken-replies"

describe("findVoicePluginOptions", () => {
  it("finds the plugin options in OpenCode config documents", () => {
    const options = findVoicePluginOptions({
      data: [
        {
          type: "document",
          info: {
            plugins: [
              {
                package: packageName,
                options: { ttsServiceCommand: "C:\\nvm4w\\nodejs\\node.exe" },
              },
            ],
          },
        },
      ],
    })

    expect(options).toEqual({ ttsServiceCommand: "C:\\nvm4w\\nodejs\\node.exe" })
  })

  it("merges matching options across config documents by precedence", () => {
    const options = findVoicePluginOptions([
      {
        info: {
          plugins: [{ package: packageName, options: { voice: "af_heart", speakOnIdle: true } }],
        },
      },
      {
        info: {
          plugins: [{ package: packageName, options: { ttsServiceCommand: "node.exe", speakOnIdle: false } }],
        },
      },
    ])

    expect(options).toEqual({
      voice: "af_heart",
      ttsServiceCommand: "node.exe",
      speakOnIdle: false,
    })
  })

  it("supports legacy package-and-options tuples", () => {
    expect(findVoicePluginOptions({ plugin: [[packageName, { ttsServiceCommand: "node.exe" }]] })).toEqual({
      ttsServiceCommand: "node.exe",
    })
  })

  it("ignores other plugins and entries without options", () => {
    expect(
      findVoicePluginOptions({
        plugins: [
          { package: "@someone/other-plugin", options: { ttsServiceCommand: "wrong.exe" } },
          packageName,
        ],
      }),
    ).toBeUndefined()
  })
})

describe("mergeVoicePluginOptions", () => {
  it("lets runtime options override config fallback options", () => {
    expect(
      mergeVoicePluginOptions(
        { ttsServiceCommand: "node.exe", speakOnIdle: true },
        { speakOnIdle: false },
      ),
    ).toEqual({ ttsServiceCommand: "node.exe", speakOnIdle: false })
  })
})
