/**
 * Turning socket failures into something a user can act on.
 *
 * A raw `java.net.ConnectException: ... EHOSTUNREACH (No route to host)` tells
 * a developer exactly what happened and tells a user nothing. Each of these
 * failures has a *different* real-world cause and a different fix, so they are
 * worth distinguishing rather than collapsing into "could not connect".
 */
export type ConnectFailure =
  | 'no-route'
  | 'refused'
  | 'timeout'
  | 'network-down'
  | 'unknown';

export function classifyConnectError(error: unknown): ConnectFailure {
  const text = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();

  // ARP never resolved, or the address is on a network we are not part of.
  if (text.includes('ehostunreach') || text.includes('no route to host')) {
    return 'no-route';
  }
  // Nothing listening on that port — the peer's app is closed or restarted.
  if (text.includes('econnrefused') || text.includes('connection refused')) {
    return 'refused';
  }
  if (
    text.includes('etimedout') ||
    text.includes('timeout') ||
    text.includes('timed out')
  ) {
    return 'timeout';
  }
  if (
    text.includes('enetunreach') ||
    text.includes('network is unreachable') ||
    text.includes('enetdown')
  ) {
    return 'network-down';
  }
  return 'unknown';
}

/**
 * What to tell the user.
 *
 * Each string names the most likely cause *and* what to do, because "no route
 * to host" between two devices that both look like 192.168.1.x is genuinely
 * confusing — the usual culprits are two different networks that happen to
 * share a subnet number, or a router with client isolation switched on.
 */
export function describeConnectFailure(
  failure: ConnectFailure,
  deviceName: string,
): string {
  switch (failure) {
    case 'no-route':
      return `Can't reach ${deviceName}. Make sure both devices are on the same Wi-Fi — and if they are, your router may have "AP isolation" or "client isolation" turned on, which blocks devices from talking to each other. Sharing a hotspot from one phone always works.`;
    case 'refused':
      return `${deviceName} refused the connection. FortShare may have been closed or restarted on that device — open it and try again.`;
    case 'timeout':
      return `${deviceName} didn't respond in time. It may have gone out of range or switched networks.`;
    case 'network-down':
      return 'This device has no usable network. Connect to Wi-Fi or a hotspot — no internet is needed.';
    case 'unknown':
      return `Could not connect to ${deviceName}.`;
    default:
      return `Could not connect to ${deviceName}.`;
  }
}

/** True when retrying a different address for the same peer could help. */
export function worthTryingAnotherAddress(failure: ConnectFailure): boolean {
  // A refusal or a timeout means we *reached* a host; a different address is
  // unlikely to be better. No-route means this particular address is on the
  // wrong network, so another one may well work.
  return failure === 'no-route' || failure === 'unknown';
}
