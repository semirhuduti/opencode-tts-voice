import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import {
  createTtsFriendlySkillToolOutput,
  hasLoadedTtsFriendlySkill,
  isTtsEnabled,
  readTtsFriendlySkill,
  stripSkillFrontmatter,
  ttsStateFile,
  ttsFriendlySkillCandidatePaths,
} from "../src/skill-system-prompt.js"
import { KV_ENABLED } from "../src/voice-constants.js"

const SKILL = "tts-friendly-responses"

describe("skill system prompt", () => {
  it("looks in project, global, and bundled skill locations", () => {
    const paths = ttsFriendlySkillCandidatePaths({
      directory: "/repo/project/package",
      worktree: "/repo/project",
      home: "/home/user",
      configDir: "/custom/config",
      bundledPath: "/package/skill/SKILL.md",
    })

    expect(paths).toContain(path.join("/repo/project/package", ".agents", "skills", SKILL, "SKILL.md"))
    expect(paths).toContain(path.join("/repo/project", ".opencode", "skills", SKILL, "SKILL.md"))
    expect(paths).toContain(path.join("/custom/config", "skills", SKILL, "SKILL.md"))
    expect(paths).toContain(path.join("/home/user", ".agents", "skills", SKILL, "SKILL.md"))
    expect(paths.at(-1)).toBe("/package/skill/SKILL.md")
  })

  it("strips frontmatter before building the skill tool output", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-tts-skill-output-"))
    const file = path.join(dir, "SKILL.md")
    const content = ["---", `name: ${SKILL}`, "description: Test skill", "---", "# Speak Clearly"].join("\n")
    await writeFile(file, content)

    expect(stripSkillFrontmatter(content)).toBe("# Speak Clearly")
    const output = await createTtsFriendlySkillToolOutput({ file, content })
    expect(output).toContain("# Speak Clearly")
    expect(output).not.toContain("description: Test skill")
    expect(output).toContain(`<skill_content name="${SKILL}">`)
  })

  it("detects when the skill has already been loaded into message history", () => {
    const output = `<skill_content name="${SKILL}">\n# Skill: ${SKILL}\n</skill_content>`

    expect(
      hasLoadedTtsFriendlySkill([
        {
          parts: [
            {
              type: "tool",
              tool: "skill",
              state: {
                status: "completed",
                input: { name: SKILL },
                output,
              },
            },
          ],
        },
      ]),
    ).toBe(true)
    expect(hasLoadedTtsFriendlySkill([{ parts: [] }])).toBe(false)
  })

  it("reads the first existing skill candidate", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-tts-skill-"))
    const bundled = path.join(dir, "bundled", "SKILL.md")
    const project = path.join(dir, ".agents", "skills", SKILL, "SKILL.md")
    await mkdir(path.dirname(bundled), { recursive: true })
    await mkdir(path.dirname(project), { recursive: true })
    await writeFile(bundled, "Bundled skill")
    await writeFile(project, "Project skill")

    const result = await readTtsFriendlySkill({ directory: dir, worktree: dir, home: "", bundledPath: bundled })

    expect(result).toEqual({ file: project, content: "Project skill" })
  })

  it("reads the persisted TTS enabled state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-tts-state-"))
    const stateFile = path.join(dir, "kv.json")

    expect(ttsStateFile({ home: "/home/user", env: { XDG_STATE_HOME: "/state" } })).toBe(
      path.join("/state", "opencode", "kv.json"),
    )
    expect(await isTtsEnabled({ stateFile })).toBe(true)

    await writeFile(stateFile, JSON.stringify({ [KV_ENABLED]: false }))
    expect(await isTtsEnabled({ stateFile })).toBe(false)

    await writeFile(stateFile, JSON.stringify({ [KV_ENABLED]: true }))
    expect(await isTtsEnabled({ stateFile })).toBe(true)
  })
})
