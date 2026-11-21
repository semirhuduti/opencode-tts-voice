import { Rpc } from "@opencode/plugin/rpc"
import { PLUGIN_ID } from "./voice-constants.js"

const state = {
  type: "object",
  properties: { enabled: { type: "boolean" } },
  required: ["enabled"],
  additionalProperties: false,
} as const

export const VoiceRpc = Rpc.define({
  id: PLUGIN_ID,
  methods: {
    getEnabled: {
      input: { type: "object", additionalProperties: false },
      output: state,
    },
    setEnabled: { input: state, output: state },
  },
  events: {
    stateChanged: { schema: state },
  },
})
