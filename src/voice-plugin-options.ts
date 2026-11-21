import { PLUGIN_PACKAGE } from "./voice-constants.js"
import type { VoicePluginOptions } from "./voice-types.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function optionsFromEntry(entry: unknown): Record<string, unknown> | undefined {
  if (isRecord(entry) && entry.package === PLUGIN_PACKAGE && isRecord(entry.options)) {
    return entry.options
  }

  if (
    Array.isArray(entry) &&
    entry[0] === PLUGIN_PACKAGE &&
    isRecord(entry[1])
  ) {
    return entry[1]
  }

  return undefined
}

export function findVoicePluginOptions(response: unknown): VoicePluginOptions | undefined {
  const payload = isRecord(response) && "data" in response ? response.data : response
  const documents = Array.isArray(payload) ? payload : [payload]
  const options: Record<string, unknown> = {}
  let found = false

  for (const document of documents) {
    if (!isRecord(document)) continue
    const info = isRecord(document.info) ? document.info : document
    const entries = Array.isArray(info.plugins) ? info.plugins : Array.isArray(info.plugin) ? info.plugin : []

    for (const entry of entries) {
      const configured = optionsFromEntry(entry)
      if (!configured) continue
      Object.assign(options, configured)
      found = true
    }
  }

  return found ? (options as VoicePluginOptions) : undefined
}

export function mergeVoicePluginOptions(
  configured: VoicePluginOptions | undefined,
  runtime: unknown,
): VoicePluginOptions {
  return {
    ...(configured ?? {}),
    ...(isRecord(runtime) ? runtime : {}),
  }
}
