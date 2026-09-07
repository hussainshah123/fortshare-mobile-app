/**
 * Transfer speed and ETA (§20, §21).
 *
 * A raw "bytes since last event / elapsed" figure jumps around too much to
 * read, because Wi-Fi throughput is bursty and progress events are throttled.
 * This smooths it with an exponentially weighted moving average over roughly a
 * two-second window, which is stable enough to display but still reacts when
 * the link genuinely slows down.
 */
export class SpeedTracker {
  /**
   * `-1` means "not started". A zero sentinel would be ambiguous, because
   * `Date.now()` can legitimately be 0 (and is, under fake timers), which
   * would make the first sample look like a restart.
   */
  private static readonly UNSET = -1;

  private lastBytes = 0;
  private lastAt = SpeedTracker.UNSET;
  private smoothed = 0;
  private startedAt = SpeedTracker.UNSET;
  private startBytes = 0;

  /** Weight given to the newest sample. Higher = twitchier. */
  private static readonly ALPHA = 0.25;
  /** Ignore samples closer together than this; they are mostly noise. */
  private static readonly MIN_SAMPLE_MS = 120;

  start(atBytes: number): void {
    const now = Date.now();
    this.lastBytes = atBytes;
    this.startBytes = atBytes;
    this.lastAt = now;
    this.startedAt = now;
    this.smoothed = 0;
  }

  /** Feed a cumulative byte count. Returns the smoothed bytes/sec. */
  update(totalBytes: number): number {
    const now = Date.now();
    if (this.lastAt === SpeedTracker.UNSET) {
      this.start(totalBytes);
      return 0;
    }

    const elapsed = now - this.lastAt;
    if (elapsed < SpeedTracker.MIN_SAMPLE_MS) return this.smoothed;

    const delta = totalBytes - this.lastBytes;
    this.lastBytes = totalBytes;
    this.lastAt = now;

    // A negative delta means the transfer restarted at a lower offset.
    if (delta < 0) {
      this.start(totalBytes);
      return 0;
    }

    const instant = (delta / elapsed) * 1000;
    this.smoothed =
      this.smoothed === 0
        ? instant
        : SpeedTracker.ALPHA * instant + (1 - SpeedTracker.ALPHA) * this.smoothed;
    return this.smoothed;
  }

  /** Pauses hold the last reading rather than decaying it to zero. */
  get current(): number {
    return this.smoothed;
  }

  /** Seconds remaining, or null while the speed is still unknown. */
  eta(transferredBytes: number, totalBytes: number): number | null {
    if (this.smoothed <= 0) return null;
    const remaining = totalBytes - transferredBytes;
    if (remaining <= 0) return 0;
    return remaining / this.smoothed;
  }

  /** Bytes/sec over the whole transfer — what gets stored in history. */
  average(finalBytes: number): number {
    if (this.startedAt === SpeedTracker.UNSET) return 0;
    const elapsed = Date.now() - this.startedAt;
    if (elapsed <= 0) return 0;
    return ((finalBytes - this.startBytes) / elapsed) * 1000;
  }

  get elapsedMs(): number {
    return this.startedAt === SpeedTracker.UNSET
      ? 0
      : Date.now() - this.startedAt;
  }

  /**
   * Called when a transfer resumes.
   *
   * Keeps the original start time so the pause is reflected in the *average*
   * rather than being mistaken for a slow link, while resetting the smoothed
   * rate so the first post-resume sample is not compared against a stale one.
   */
  resumeFrom(atBytes: number): void {
    const previousStart = this.startedAt;
    this.start(atBytes);
    if (previousStart !== SpeedTracker.UNSET) this.startedAt = previousStart;
  }
}
