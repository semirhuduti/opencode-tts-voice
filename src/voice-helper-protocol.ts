import type { VoiceConfig, VoiceState } from "./voice-types.js"

export type RuntimeStatus = Partial<Pick<VoiceState, "device" | "error">>

export type HelperRequest =
  | {
      type: "generate"
      id: number
      epoch: number
      text: string
      config: VoiceConfig
    }
  | {
      type: "cancel"
      id?: number
      epoch?: number
    }
  | {
      type: "dispose"
    }

export type HelperResponse =
  | {
      type: "status"
      status: RuntimeStatus
    }
  | {
      type: "segment"
      id: number
      epoch: number
      text: string
      file: string
    }
  | {
      type: "complete"
      id: number
      epoch: number
    }
  | {
      type: "cancelled"
      id: number
      epoch: number
    }
  | {
      type: "error"
      id?: number
      epoch?: number
      error: string
    }
