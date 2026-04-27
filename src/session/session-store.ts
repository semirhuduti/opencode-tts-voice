import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createLogger } from "../voice-log.js"
import { formatError } from "../shared/voice-utils.js"

type SessionParentInfo = {
  id?: string | null
  parentID?: string | null
}

type SessionDeletedCallback = (sessionID: string) => void

export class SessionStore {
  private readonly log = createLogger("session")
  private readonly sessionParents = new Map<string, string | undefined>()
  private readonly sessionParentLookups = new Map<string, Promise<string | undefined>>()
  private readonly cleanupCallbacks = new Set<SessionDeletedCallback>()
  private readonly cleanup: Array<() => void> = []
  private disposed = false

  constructor(
    private readonly api: TuiPluginApi,
    private readonly speakSubagentResponses: boolean,
  ) {
    this.cleanup.push(
      api.event.on("session.created", (event) => this.cacheSession(event.properties.sessionID, event.properties.info)),
      api.event.on("session.updated", (event) => this.cacheSession(event.properties.sessionID, event.properties.info)),
      api.event.on("session.deleted", (event) => this.forgetSession(event.properties.sessionID)),
    )
  }

  onDeleted(callback: SessionDeletedCallback) {
    this.cleanupCallbacks.add(callback)
    return () => {
      this.cleanupCallbacks.delete(callback)
    }
  }

  cacheSession(sessionID: string, session: SessionParentInfo) {
    const id = typeof session.id === "string" && session.id ? session.id : sessionID
    const hasParentID = "parentID" in session
    const parentID = typeof session.parentID === "string" && session.parentID ? session.parentID : undefined

    if (hasParentID) this.sessionParents.set(id, parentID)
    this.sessionParentLookups.delete(id)
    this.log.debug("session cached", {
      sessionID: id,
      parentID: this.sessionParents.get(id) ?? null,
      subagent: Boolean(this.sessionParents.get(id)),
    })
  }

  forgetSession(sessionID: string) {
    this.sessionParents.delete(sessionID)
    this.sessionParentLookups.delete(sessionID)
    for (const callback of this.cleanupCallbacks) callback(sessionID)
  }

  async shouldSpeakSession(sessionID: string) {
    if (this.speakSubagentResponses) return true

    const parentID = await this.sessionParentID(sessionID)
    const allowed = !parentID
    if (!allowed) {
      this.log.debug("speech skipped for subagent session", { sessionID, parentID })
    }
    return allowed
  }

  async sessionParentID(sessionID: string) {
    if (this.sessionParents.has(sessionID)) return this.sessionParents.get(sessionID)

    const existing = this.sessionParentLookups.get(sessionID)
    if (existing) return existing

    const lookup = this.fetchSessionParentID(sessionID).finally(() => {
      this.sessionParentLookups.delete(sessionID)
    })
    this.sessionParentLookups.set(sessionID, lookup)
    return lookup
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.cleanup) off()
    this.cleanup.length = 0
    this.cleanupCallbacks.clear()
  }

  private async fetchSessionParentID(sessionID: string) {
    try {
      const result = await this.api.client.session.get({ sessionID })
      if (result.data) {
        this.cacheSession(sessionID, result.data)
        return result.data.parentID
      }

      this.log.warn("session lookup failed", {
        sessionID,
        error: result.error ? formatError(result.error) : undefined,
      })
    } catch (error) {
      this.log.warn("session lookup failed", { sessionID, error: formatError(error) })
    }

    this.sessionParents.set(sessionID, undefined)
    return undefined
  }
}
