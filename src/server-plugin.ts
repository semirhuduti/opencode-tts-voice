import type { PluginModule } from "@opencode-ai/plugin"
import { PLUGIN_ID } from "./voice-constants.js"

const plugin: PluginModule & { id: string } = {
  id: PLUGIN_ID,
  server: async () => ({}),
}

export default plugin
