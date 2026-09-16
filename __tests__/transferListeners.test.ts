/**
 * Listener lifecycle on the transfer engine.
 *
 * The engine subscribes to two sources: native transfer events, and
 * SessionManager control frames. `stop()` used to unsubscribe only from the
 * first, so a stop/start cycle — which happens whenever networking is
 * restarted — left the old SessionManager listeners in place and added a
 * second set. Every control frame was then delivered twice.
 *
 * For a TRANSFER_OFFER that was fatal: the first delivery opened the approval
 * prompt, the second found a prompt already open and refused the offer, and
 * the sender aborted with "declined by user" while the receiver was still
 * looking at the dialog with Accept untapped.
 */

const mockMessageListeners = new Set<() => void>();
const mockSessionEndListeners = new Set<() => void>();

// The native module is stubbed globally with an empty object; the engine also
// subscribes to its event emitters, so those have to exist here.
jest.mock('../src/native/specs/NativeFortShareNet', () => {
  const emitter = () => ({ remove: () => {} });
  return {
    __esModule: true,
    default: {
      onSendProgress: emitter,
      onReceiveProgress: emitter,
      onSendComplete: emitter,
      onReceiveComplete: emitter,
      onTransferError: emitter,
    },
  };
});

jest.mock('../src/network/session/SessionManager', () => ({
  SessionManager: {
    onMessage: (listener: () => void) => {
      mockMessageListeners.add(listener);
      return () => mockMessageListeners.delete(listener);
    },
    onSessionEnd: (listener: () => void) => {
      mockSessionEndListeners.add(listener);
      return () => mockSessionEndListeners.delete(listener);
    },
    send: jest.fn(async () => {}),
    session: jest.fn(() => null),
  },
}));

import { TransferEngine } from '../src/network/transfer/TransferEngine';

const options = {
  approveTransfer: async () => ({ accepted: true as const }),
  resolveDuplicate: async () => 'keep-both' as const,
};

beforeEach(() => {
  mockMessageListeners.clear();
  mockSessionEndListeners.clear();
  TransferEngine.stop();
});

afterAll(() => {
  TransferEngine.stop();
});

it('subscribes to control frames exactly once', () => {
  TransferEngine.start(options);

  expect(mockMessageListeners.size).toBe(1);
  expect(mockSessionEndListeners.size).toBe(1);
});

it('ignores a repeated start', () => {
  TransferEngine.start(options);
  TransferEngine.start(options);

  expect(mockMessageListeners.size).toBe(1);
});

it('lets go of its control-frame listeners on stop', () => {
  TransferEngine.start(options);
  TransferEngine.stop();

  expect(mockMessageListeners.size).toBe(0);
  expect(mockSessionEndListeners.size).toBe(0);
});

it('does not accumulate listeners across a restart', () => {
  // Networking restarts on a Wi-Fi change, so this cycle is routine — and
  // before the fix each pass through it doubled the delivery of every frame.
  for (let i = 0; i < 5; i += 1) {
    TransferEngine.start(options);
    TransferEngine.stop();
  }
  TransferEngine.start(options);

  expect(mockMessageListeners.size).toBe(1);
  expect(mockSessionEndListeners.size).toBe(1);
});
