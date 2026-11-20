import { Plugin } from "@opencode/plugin"
import { createTtsFriendlySystemPrompt } from "./system-prompt-injection.js"
import { VoiceRpc } from "./voice-rpc.js"
import { PLUGIN_ID } from "./voice-constants.js"
import { createLogger } from "./voice-log.js"

const log = createLogger("skill")

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    let stateWrites = Promise.resolve()
    let emitState: (enabled: boolean) => Promise<void> = async () => {}
    const registration = await ctx.rpc.register(VoiceRpc, {
      getEnabled: async () => {
        await stateWrites.catch(() => undefined)
        return { enabled: (await ctx.storage.get("enabled")) !== false }
      },
      setEnabled: (input) => {
        const { enabled } = input as { enabled: boolean }
        const next = stateWrites.catch(() => undefined).then(async () => {
          await ctx.storage.set("enabled", enabled)
          try {
            await emitState(enabled)
          } catch (error) {
            log.warn("voice state event failed", { error: String(error) })
          }
        })
        stateWrites = next
        return next.then(() => ({ enabled }))
      },
    })
    emitState = (enabled) => registration.events.emit("stateChanged", { enabled })

    await ctx.session.hook("context", async (event) => {
      await stateWrites.catch(() => undefined)
      if ((await ctx.storage.get("enabled")) === false) return
      event.system.push({ type: "text", text: createTtsFriendlySystemPrompt() })
      log.debug("tts-friendly guidance added to system prompt", { sessionID: event.sessionID })
    })
  },
})
