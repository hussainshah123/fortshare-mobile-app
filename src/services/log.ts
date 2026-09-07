/**
 * Diagnostics.
 *
 * A P2P connection fails across four layers — mDNS, TCP, the frame codec, the
 * handshake — and the user only ever sees "could not connect". Every step is
 * therefore logged with a scope, so React Native DevTools shows the sequence
 * and the last line before the silence tells you which layer gave up.
 *
 * Kept deliberately plain: `console` calls, so they appear in DevTools, in
 * `npx react-native log-android`/`log-ios`, and in a terminal Metro session
 * with no extra setup.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * In development everything is shown. In release only warnings and errors, so
 * a transfer's progress events do not flood a user's console.
 */
const MIN_LEVEL: LogLevel = __DEV__ ? 'debug' : 'warn';

export interface LogEntry {
  at: number;
  level: LogLevel;
  scope: string;
  message: string;
  detail?: unknown;
}

/**
 * The last N entries, kept in memory so a support/diagnostics view can show
 * what happened without the user having to reproduce it attached to a laptop.
 */
const RING_SIZE = 400;
const ring: LogEntry[] = [];

function record(entry: LogEntry): void {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
}

/** Newest last. */
export function logHistory(): readonly LogEntry[] {
  return ring;
}

export function clearLogHistory(): void {
  ring.length = 0;
}

/** Plain-text dump, for sharing from a diagnostics screen. */
export function formatLogHistory(): string {
  return ring
    .map((entry) => {
      const time = new Date(entry.at).toISOString().slice(11, 23);
      const detail =
        entry.detail === undefined ? '' : ` ${safeStringify(entry.detail)}`;
      return `${time} ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.message}${detail}`;
    })
    .join('\n');
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  debug: (message: string, detail?: unknown) => void;
  info: (message: string, detail?: unknown) => void;
  warn: (message: string, detail?: unknown) => void;
  error: (message: string, detail?: unknown) => void;
}

/**
 * A logger for one subsystem, e.g. `logger('handshake')`.
 *
 * The scope is what makes the output readable: filtering DevTools by
 * "FortShare:handshake" shows the authentication sequence and nothing else.
 */
export function logger(scope: string): Logger {
  const emit = (level: LogLevel, message: string, detail?: unknown): void => {
    record({ at: Date.now(), level, scope, message, detail });
    if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;

    const tag = `[FortShare:${scope}]`;
    const args: unknown[] = detail === undefined ? [tag, message] : [tag, message, detail];

    switch (level) {
      case 'error':
        console.error(...args);
        return;
      case 'warn':
        console.warn(...args);
        return;
      default:
        // `console.log` rather than `console.debug`: DevTools hides debug-level
        // output by default, which would make these invisible exactly when
        // they are needed.
        console.log(...args);
    }
  };

  return {
    debug: (message, detail) => emit('debug', message, detail),
    info: (message, detail) => emit('info', message, detail),
    warn: (message, detail) => emit('warn', message, detail),
    error: (message, detail) => emit('error', message, detail),
  };
}
