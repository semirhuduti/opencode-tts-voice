import { readFile, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { KV_ENABLED } from "./voice-constants.js"

export const TTS_FRIENDLY_SKILL_NAME = "tts-friendly-responses"
const DEFAULT_TTS_ENABLED = true
const TOOL_OUTPUT_FILE_LIMIT = 10

type ToolPartLike = {
  type: string
  tool?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    output?: string
  }
}

type MessageLike = {
  parts: readonly ToolPartLike[]
}

export type SkillSearchOptions = {
  directory: string
  worktree?: string
  home?: string
  configDir?: string
  bundledPath?: string
}

export type TtsEnabledOptions = {
  home?: string
  stateFile?: string
  env?: Pick<NodeJS.ProcessEnv, "XDG_STATE_HOME">
}

function bundledSkillPath() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "agents",
    "skills",
    TTS_FRIENDLY_SKILL_NAME,
    "SKILL.md",
  )
}

function configHome(home: string) {
  return process.env.XDG_CONFIG_HOME || path.join(home, ".config")
}

export function ttsStateFile(options?: TtsEnabledOptions) {
  if (options?.stateFile) return options.stateFile

  const home = options?.home ?? os.homedir()
  const stateHome = options?.env?.XDG_STATE_HOME || process.env.XDG_STATE_HOME || (home ? path.join(home, ".local", "state") : undefined)
  if (!stateHome) return
  return path.join(stateHome, "opencode", "kv.json")
}

export async function isTtsEnabled(options?: TtsEnabledOptions) {
  const file = ttsStateFile(options)
  if (!file) return DEFAULT_TTS_ENABLED

  try {
    const data = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    return typeof data[KV_ENABLED] === "boolean" ? data[KV_ENABLED] : DEFAULT_TTS_ENABLED
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_TTS_ENABLED
    throw error
  }
}

function ancestors(start: string, stop?: string) {
  const root = path.parse(start).root
  const boundary = stop ? path.resolve(stop) : root
  const output: string[] = []
  let current = path.resolve(start)

  while (true) {
    output.push(current)
    if (current === boundary || current === root) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return output
}

function skillFile(dir: string, base: string) {
  return path.join(dir, base, "skills", TTS_FRIENDLY_SKILL_NAME, "SKILL.md")
}

export function ttsFriendlySkillCandidatePaths(options: SkillSearchOptions) {
  const home = options.home ?? os.homedir()
  const configDir = options.configDir ?? process.env.OPENCODE_CONFIG_DIR
  const paths: string[] = []

  for (const dir of ancestors(options.directory, options.worktree)) {
    paths.push(path.join(dir, ".opencode", "skills", TTS_FRIENDLY_SKILL_NAME, "SKILL.md"))
    paths.push(path.join(dir, ".opencode", "skill", TTS_FRIENDLY_SKILL_NAME, "SKILL.md"))
    paths.push(skillFile(dir, ".agents"))
    paths.push(skillFile(dir, ".claude"))
  }

  if (configDir) {
    paths.push(path.join(configDir, "skills", TTS_FRIENDLY_SKILL_NAME, "SKILL.md"))
    paths.push(path.join(configDir, "skill", TTS_FRIENDLY_SKILL_NAME, "SKILL.md"))
  }

  if (home) {
    const opencodeConfig = path.join(configHome(home), "opencode")
    paths.push(path.join(opencodeConfig, "skills", TTS_FRIENDLY_SKILL_NAME, "SKILL.md"))
    paths.push(path.join(opencodeConfig, "skill", TTS_FRIENDLY_SKILL_NAME, "SKILL.md"))
    paths.push(skillFile(home, ".agents"))
    paths.push(skillFile(home, ".claude"))
  }

  paths.push(options.bundledPath ?? bundledSkillPath())
  return Array.from(new Set(paths))
}

export function stripSkillFrontmatter(text: string) {
  return text.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "").trim()
}

export async function readTtsFriendlySkill(options: SkillSearchOptions) {
  for (const file of ttsFriendlySkillCandidatePaths(options)) {
    try {
      const content = stripSkillFrontmatter(await readFile(file, "utf8"))
      if (content) return { file, content }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}

async function sampledSkillFiles(skillFile: string, limit = TOOL_OUTPUT_FILE_LIMIT) {
  const root = path.dirname(skillFile)
  const queue = [root]
  const files: string[] = []

  while (queue.length > 0 && files.length < limit) {
    const dir = queue.shift()
    if (!dir) break

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      break
    }

    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
        continue
      }
      if (!entry.isFile() || entry.name === "SKILL.md") continue

      files.push(full)
      if (files.length >= limit) break
    }
  }

  return files
}

export async function createTtsFriendlySkillToolOutput(skill: { file: string; content: string }) {
  const files = await sampledSkillFiles(skill.file)

  return [
    `<skill_content name="${TTS_FRIENDLY_SKILL_NAME}">`,
    `# Skill: ${TTS_FRIENDLY_SKILL_NAME}`,
    "",
    stripSkillFrontmatter(skill.content),
    "",
    `Base directory for this skill: ${pathToFileURL(path.dirname(skill.file)).href}`,
    "Relative paths in this skill, for example scripts slash or reference slash, are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${file}</file>`),
    "</skill_files>",
    "</skill_content>",
  ]
    .filter(Boolean)
    .join("\n")
}

export function hasLoadedTtsFriendlySkill(messages: readonly MessageLike[]) {
  return messages.some((message) =>
    message.parts.some((part) => {
      if (part.type !== "tool" || part.tool !== "skill" || part.state?.status !== "completed") return false

      return part.state.input?.name === TTS_FRIENDLY_SKILL_NAME || part.state.output?.includes(`<skill_content name="${TTS_FRIENDLY_SKILL_NAME}">`) === true
    }),
  )
}
