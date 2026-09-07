/**
 * Formatting used across the UI. Kept in one place so a file size or a
 * timestamp never renders two different ways on two screens.
 */

const KB = 1024;
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Human file size, e.g. "428 MB", "1.2 GB".
 *
 * Precision shrinks as the number grows: "1.2 GB" is useful, "1.24 GB" is
 * noise, and "428.0 MB" is worse than "428 MB".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  let value = bytes;
  let unit = 0;
  while (value >= KB && unit < UNITS.length - 1) {
    value /= KB;
    unit += 1;
  }

  const decimals = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 1;
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}

/** Transfer rate, e.g. "22.4 MB/s". */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * Remaining time, e.g. "24 sec", "3 min 10 sec", "1 hr 5 min".
 * Returns "—" while the speed is still unknown.
 */
export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 1) return 'almost done';
  if (seconds < 60) return `${Math.ceil(seconds)} sec`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = Math.round(seconds % 60);
    return rest > 0 ? `${minutes} min ${rest} sec` : `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours} hr ${restMinutes} min` : `${hours} hr`;
}

/** Elapsed duration for a completed transfer, e.g. "1 min 12 sec". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  return formatEta(ms / 1000);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "Last seen" phrasing, e.g. "Just now", "Yesterday", "3 days ago".
 *
 * Day boundaries are calendar-based rather than a flat 24-hour count, so
 * something at 11pm yesterday reads as "Yesterday" at 1am rather than
 * "1 hour ago".
 */
export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return 'Never';

  const now = Date.now();
  const diff = now - timestamp;
  if (diff < 0) return 'Just now';
  if (diff < MINUTE) return 'Just now';
  if (diff < HOUR) {
    const minutes = Math.floor(diff / MINUTE);
    return `${minutes} min ago`;
  }

  const days = calendarDaysBetween(timestamp, now);
  if (days === 0) {
    const hours = Math.floor(diff / HOUR);
    return hours <= 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? 'Last week' : `${weeks} weeks ago`;
  }
  return formatDate(timestamp);
}

/** Whole calendar days between two instants, ignoring time of day. */
function calendarDaysBetween(from: number, to: number): number {
  const start = new Date(from);
  const end = new Date(to);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return Math.round((end.getTime() - start.getTime()) / DAY);
}

/** "10:42 AM" */
export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "Aug 12, 2026" */
export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** "Today, 9:42 AM" — used on the offline device screen (§12). */
export function formatDateTime(timestamp: number): string {
  if (!timestamp) return 'Never';
  const days = calendarDaysBetween(timestamp, Date.now());
  if (days === 0) return `Today, ${formatTime(timestamp)}`;
  if (days === 1) return `Yesterday, ${formatTime(timestamp)}`;
  return `${formatDate(timestamp)}, ${formatTime(timestamp)}`;
}

/** Section headings for grouped history (§22, §25). */
export type DateGroup = 'Today' | 'Yesterday' | 'This Week' | 'Older';

export function dateGroupOf(timestamp: number): DateGroup {
  const days = calendarDaysBetween(timestamp, Date.now());
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This Week';
  return 'Older';
}

/** Groups items into Today / Yesterday / This Week / Older, order preserved. */
export function groupByDate<T>(
  items: T[],
  timestampOf: (item: T) => number,
): { title: DateGroup; data: T[] }[] {
  const order: DateGroup[] = ['Today', 'Yesterday', 'This Week', 'Older'];
  const buckets = new Map<DateGroup, T[]>();

  for (const item of items) {
    const group = dateGroupOf(timestampOf(item));
    const bucket = buckets.get(group);
    if (bucket) bucket.push(item);
    else buckets.set(group, [item]);
  }

  return order
    .filter((group) => (buckets.get(group)?.length ?? 0) > 0)
    .map((group) => ({ title: group, data: buckets.get(group) ?? [] }));
}

/** "3 files" / "1 file" */
export function pluralize(count: number, singular: string, plural?: string): string {
  const word = count === 1 ? singular : plural ?? `${singular}s`;
  return `${count} ${word}`;
}

/** Percentage clamped to 0-100, for progress bars. */
export function percentOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

/** Truncates the middle so both the name and the extension stay visible. */
export function truncateMiddle(text: string, max = 28): string {
  if (text.length <= max) return text;
  const keep = Math.floor((max - 1) / 2);
  return `${text.slice(0, keep)}…${text.slice(text.length - keep)}`;
}
