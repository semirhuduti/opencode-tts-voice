export class TimerRegistry {
  private readonly timers = new Set<NodeJS.Timeout>()
  private disposed = false

  setTimeout(callback: () => void, ms: number) {
    if (this.disposed) return undefined
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      callback()
    }, ms)
    this.timers.add(timer)
    return timer
  }

  clear(timer: NodeJS.Timeout | undefined) {
    if (!timer) return
    clearTimeout(timer)
    this.timers.delete(timer)
  }

  sleep(ms: number) {
    return new Promise<void>((resolve) => {
      this.setTimeout(resolve, ms)
    })
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  snapshot() {
    return { size: this.timers.size, disposed: this.disposed }
  }
}
