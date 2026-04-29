import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import {
  createTtsFriendlySkillLoadInstruction,
  isTtsEnabled,
  readTtsFriendlySkill,
  ttsFriendlySkillCandidatePaths,
} from "./skill-system-prompt.js"
import { PLUGIN_ID } from "./voice-constants.js"
import { createLogger } from "./voice-log.js"

const log = createLogger("skill")
const loadingSessions = new Set<string>()

const server: Plugin = async (ctx) => {
  return {
    "chat.message": async (input, output) => {
      if (!input.sessionID) {
        log.debug("tts-friendly skill skipped", { reason: "missing sessionID" })
        return
      }

      if (loadingSessions.has(input.sessionID)) {
        log.debug("tts-friendly skill skipped", {
          sessionID: input.sessionID,
          reason: "load already in progress",
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

      const existing = await ctx.client.session
        .messages({ path: { id: input.sessionID }, query: { limit: 2 }, throwOnError: true })
        .then((result) => result.data)
        .catch((error) => {
          log.warn("tts-friendly skill message check failed", {
            sessionID: input.sessionID,
            error: error instanceof Error ? error.message : String(error),
          })
          return undefined
        })

      if ((existing?.length ?? 0) > 1) {
        log.debug("tts-friendly skill skipped", {
          sessionID: input.sessionID,
          reason: "not first message",
          messageCount: existing?.length,
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

      loadingSessions.add(input.sessionID)
      output.message.system = [output.message.system, createTtsFriendlySkillLoadInstruction()].filter(Boolean).join("\n\n")

      log.info("tts-friendly skill load requested", {
        sessionID: input.sessionID,
        file: skill.file,
      })

      queueMicrotask(() => {
        loadingSessions.delete(input.sessionID)
      })
    },
  }
}

const plugin: PluginModule & { id: string } = {
  id: PLUGIN_ID,
  server,
}

export default plugin
