import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import type { Message, Part } from "@opencode-ai/sdk"
import {
  createTtsFriendlySkillToolOutput,
  hasLoadedTtsFriendlySkill,
  isTtsEnabled,
  readTtsFriendlySkill,
  ttsFriendlySkillCandidatePaths,
  TTS_FRIENDLY_SKILL_NAME,
} from "./skill-system-prompt.js"
import { PLUGIN_ID } from "./voice-constants.js"
import { createLogger } from "./voice-log.js"

const log = createLogger("skill")

function hasSessionID(message: Message, sessionID: string) {
  return message.sessionID === sessionID
}

function syntheticSkillMessage(input: {
  sessionID: string
  skillOutput: string
  directory: string
  worktree: string
  skillDir: string
}): { info: Message; parts: Part[] } {
  const created = Date.now()
  const messageID = `msg_tts_skill_${created.toString(36)}`
  const partID = `prt_tts_skill_${created.toString(36)}`
  const callID = `call_tts_skill_${created.toString(36)}`

  const info = {
    id: messageID,
    sessionID: input.sessionID,
    role: "assistant",
    time: { created, completed: created },
    parentID: messageID,
    modelID: "tts-friendly-skill",
    providerID: PLUGIN_ID,
    mode: "plugin",
    agent: "build",
    path: {
      cwd: input.directory,
      root: input.worktree,
    },
    summary: false,
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    finish: "stop",
  } as Message

  const part = {
    id: partID,
    sessionID: input.sessionID,
    messageID,
    type: "tool",
    callID,
    tool: "skill",
    state: {
      status: "completed",
      input: { name: TTS_FRIENDLY_SKILL_NAME },
      title: `Loaded skill: ${TTS_FRIENDLY_SKILL_NAME}`,
      output: input.skillOutput,
      metadata: {
        name: TTS_FRIENDLY_SKILL_NAME,
        dir: input.skillDir,
        injectedBy: PLUGIN_ID,
      },
      time: { start: created, end: created },
    },
  } as Part

  return {
    info,
    parts: [part],
  }
}

const server: Plugin = async (ctx) => {
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      const sessionID = output.messages.at(-1)?.info.sessionID
      if (!sessionID) {
        log.debug("tts-friendly skill skipped", { reason: "missing sessionID" })
        return
      }

      const sessionMessages = output.messages.filter((message) => hasSessionID(message.info, sessionID))
      if (hasLoadedTtsFriendlySkill(sessionMessages)) {
        log.debug("tts-friendly skill skipped", {
          sessionID,
          reason: "already loaded",
        })
        return
      }

      if (!(await isTtsEnabled())) {
        log.debug("tts-friendly skill skipped", {
          sessionID,
          reason: "tts disabled",
        })
        return
      }

      const search = {
        directory: ctx.directory,
        worktree: ctx.worktree,
      }

      const skill = await readTtsFriendlySkill(search)
      if (!skill) {
        log.warn("tts-friendly skill unavailable", {
          sessionID,
          searchPaths: ttsFriendlySkillCandidatePaths(search),
        })
        return
      }

      output.messages.push(
        syntheticSkillMessage({
          sessionID,
          skillOutput: await createTtsFriendlySkillToolOutput(skill),
          directory: ctx.directory,
          worktree: ctx.worktree,
          skillDir: skill.file.replace(/[\\/]SKILL\.md$/, ""),
        }),
      )

      log.info("tts-friendly skill loaded", {
        sessionID,
        file: skill.file,
      })
    },
    "experimental.chat.system.transform": async (input, _output) => {
      if (!input.sessionID) {
        log.debug("tts-friendly skill skipped", { reason: "missing sessionID" })
        return
      }

      log.debug("tts-friendly system injection disabled", {
        sessionID: input.sessionID,
        reason: "using synthetic skill tool message",
      })
    },
  }
}

const plugin: PluginModule & { id: string } = {
  id: PLUGIN_ID,
  server,
}

export default plugin
