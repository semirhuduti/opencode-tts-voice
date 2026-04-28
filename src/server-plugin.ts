import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import {
  createTtsFriendlySkillPrompt,
  hasTtsFriendlySkillPrompt,
  isTtsEnabled,
  readTtsFriendlySkill,
} from "./skill-system-prompt.js"
import { PLUGIN_ID } from "./voice-constants.js"
import { createLogger } from "./voice-log.js"

const log = createLogger("skill")

const server: Plugin = async (ctx) => {
  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID || hasTtsFriendlySkillPrompt(output.system)) return
      if (!(await isTtsEnabled())) return

      const skill = await readTtsFriendlySkill({
        directory: ctx.directory,
        worktree: ctx.worktree,
      })
      if (!skill) return

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
