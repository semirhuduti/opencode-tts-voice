import { describe, expect, it } from "bun:test"
import { createTtsFriendlySystemPrompt } from "../src/system-prompt-injection.js"

describe("system prompt injection", () => {
  it("creates a system prompt with TTS-friendly guidance", () => {
    const prompt = createTtsFriendlySystemPrompt()

    expect(prompt).not.toContain("<skill_content")
    expect(prompt).toContain("Apply the following guidance as normal system instructions")
    expect(prompt).toContain("# TTS Friendly Responses")
    expect(prompt).toContain("The goal is spoken clarity")
    expect(prompt).toContain("Prefer natural, concise prose over visual structure")
    expect(prompt).toContain("For final answers, say what was completed, what was verified, and whether anything remains")
    expect(prompt).toContain("use the ask question tool instead of writing the question directly")
    expect(prompt).toContain("Ask exactly one question per ask question tool call")
    expect(prompt).toContain("wait for the user's answer before asking the next question")
    expect(prompt).toContain("Do not batch multiple questions into a single ask question tool call")
    expect(prompt).toContain("Do not mention this startup context")
  })

})
