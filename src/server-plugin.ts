import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import {
  createTtsFriendlySkillPrompt,
  hasTtsFriendlySkillPrompt,
  isTtsEnabled,
  readTtsFriendlySkill,
  ttsFriendlySkillCandidatePaths,
} from "./skill-system-prompt.js"
import { PLUGIN_ID } from "./voice-constants.js"
import { createLogger } from "./voice-log.js"

const log = createLogger("skill")

const server: Plugin = async (ctx) => {
  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) {
        log.debug("tts-friendly skill skipped", { reason: "missing sessionID" })
        return
      }

      if (hasTtsFriendlySkillPrompt(output.system)) {
        log.debug("tts-friendly skill skipped", {
          sessionID: input.sessionID,
          reason: "already present",
        })
        return
      }

      if (!(await isTtsEnabled())) {
        log.debug("tts-friendly skill skipped", {
          sessionID: input.sessionID,
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
          sessionID: input.sessionID,
          searchPaths: ttsFriendlySkillCandidatePaths(search),
        })
        return
      }

      output.system.unshift(createTtsFriendlySkillPrompt(skill.content))
      log.info("tts-friendly skill loaded", {
        sessionID: input.sessionID,
        file: skill.file,
      })
    },
  }
}

const plugin: PluginModule & { id: string } = {
  id: PLUGIN_ID,
  server,
}

export default plugin
