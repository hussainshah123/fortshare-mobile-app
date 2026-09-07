import {
  classifyConnectError,
  describeConnectFailure,
  worthTryingAnotherAddress,
} from '../src/network/session/connectErrors';

/**
 * The real messages these have to handle, captured from a device.
 *
 * The EHOSTUNREACH case is the one that mattered: two phones both on
 * 192.168.1.x, and the connection failing with a raw Java stack trace that
 * told the user nothing about what to do.
 */
describe('classifying socket failures', () => {
  it('recognises no-route, the same-subnet-but-unreachable case', () => {
    const real = new Error(
      'java.net.ConnectException: failed to connect to /192.168.1.3 (port 36043) ' +
        'from /192.168.1.59 (port 32918) after 10000ms: isConnected failed: ' +
        'EHOSTUNREACH (No route to host)',
    );
    expect(classifyConnectError(real)).toBe('no-route');
  });

  it('recognises a refused connection', () => {
    expect(
      classifyConnectError(new Error('connect failed: ECONNREFUSED (Connection refused)')),
    ).toBe('refused');
  });

  it('recognises a timeout', () => {
    expect(classifyConnectError(new Error('connection timed out'))).toBe('timeout');
    expect(classifyConnectError(new Error('ETIMEDOUT'))).toBe('timeout');
  });

  it('recognises a dead local network', () => {
    expect(
      classifyConnectError(new Error('ENETUNREACH (Network is unreachable)')),
    ).toBe('network-down');
  });

  it('falls back to unknown rather than throwing', () => {
    expect(classifyConnectError(new Error('something odd'))).toBe('unknown');
    expect(classifyConnectError('a plain string')).toBe('unknown');
    expect(classifyConnectError(undefined)).toBe('unknown');
    expect(classifyConnectError(null)).toBe('unknown');
  });
});

describe('explaining a failure to the user', () => {
  it('names the likely cause and the fix for no-route', () => {
    const message = describeConnectFailure('no-route', 'HUAWEI JSN-L22');
    expect(message).toContain('HUAWEI JSN-L22');
    // The two things that actually cause this, and the reliable workaround.
    expect(message).toContain('same Wi-Fi');
    expect(message.toLowerCase()).toContain('isolation');
    expect(message.toLowerCase()).toContain('hotspot');
  });

  it('says the app was probably closed when refused', () => {
    expect(describeConnectFailure('refused', 'Pixel 8')).toMatch(/closed|restarted/i);
  });

  it('never leaks a raw error code to the user', () => {
    const failures = [
      'no-route',
      'refused',
      'timeout',
      'network-down',
      'unknown',
    ] as const;
    for (const failure of failures) {
      const message = describeConnectFailure(failure, 'Samsung S25');
      expect(message).not.toMatch(/EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|java\.net/);
      expect(message.length).toBeGreaterThan(20);
    }
  });
});

describe('deciding whether to try another address', () => {
  it('retries when this address is on the wrong network', () => {
    expect(worthTryingAnotherAddress('no-route')).toBe(true);
    expect(worthTryingAnotherAddress('unknown')).toBe(true);
  });

  it('stops once a host has actually answered', () => {
    // A refusal or timeout means we reached *a* host; another of the peer's
    // addresses is unlikely to behave differently.
    expect(worthTryingAnotherAddress('refused')).toBe(false);
    expect(worthTryingAnotherAddress('timeout')).toBe(false);
    expect(worthTryingAnotherAddress('network-down')).toBe(false);
  });
});
