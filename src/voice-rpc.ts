import { Rpc } from "@opencode/plugin/rpc"

const state = {
  type: "object",
  properties: { enabled: { type: "boolean" } },
  required: ["enabled"],
  additionalProperties: false,
} as const

export const VoiceRpc = Rpc.define({
  id: "semirhuduti.tts.voice",
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
