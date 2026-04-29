import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createTtsFriendlySystemPrompt, isTtsEnabled } from "./system-prompt-injection.js"
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

      if (!(await isTtsEnabled())) {
        log.debug("tts-friendly skill skipped", {
          sessionID: input.sessionID,
          reason: "tts disabled",
        })
        return
      }

      output.system.push(createTtsFriendlySystemPrompt())

      log.debug("tts-friendly guidance added to system prompt", {
        sessionID: input.sessionID,
      })
    },
  }
}

const plugin: PluginModule & { id: string } = {
  id: PLUGIN_ID,
  server,
}

export default plugin
