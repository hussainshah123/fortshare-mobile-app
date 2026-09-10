/**
 * Test environment.
 *
 * The protocol, crypto, resume and formatting logic is all plain TypeScript,
 * so it can be tested without a device. What has to be stubbed is the native
 * boundary — and only the boundary, so the code under test is the real code.
 */

// `crypto.getRandomValues` is normally installed by react-native-get-random-values,
// which needs a native module. Under Node the platform already provides it.
jest.mock('react-native-get-random-values', () => ({}));

// MMKV is a Nitro module with no JS fallback. An in-memory Map behaves the same
// for everything the identity service does with it.
jest.mock('react-native-mmkv', () => {
  const store = new Map<string, string | number | boolean>();
  return {
    createMMKV: () => ({
      set: (key: string, value: string | number | boolean) => {
        store.set(key, value);
      },
      getString: (key: string) => {
        const value = store.get(key);
        return typeof value === 'string' ? value : undefined;
      },
      getNumber: (key: string) => {
        const value = store.get(key);
        return typeof value === 'number' ? value : undefined;
      },
      getBoolean: (key: string) => {
        const value = store.get(key);
        return typeof value === 'boolean' ? value : undefined;
      },
      contains: (key: string) => store.has(key),
      remove: (key: string) => store.delete(key),
      getAllKeys: () => [...store.keys()],
      clearAll: () => store.clear(),
    }),
  };
});

// Media and camera libraries reach for native modules at import time, so they
// have to be stubbed even for tests that never touch a picker — the store
// imports the permission service, which imports these.
jest.mock('@react-native-camera-roll/camera-roll', () => ({
  CameraRoll: { getPhotos: jest.fn(), getAlbums: jest.fn() },
  iosReadGalleryPermission: jest.fn(async () => 'granted'),
  iosRequestReadWriteGalleryPermission: jest.fn(async () => 'granted'),
}));

jest.mock('react-native-vision-camera', () => ({
  Camera: {
    getCameraPermissionStatus: jest.fn(() => 'granted'),
    requestCameraPermission: jest.fn(async () => 'granted'),
  },
  useCameraDevice: jest.fn(() => null),
  useCodeScanner: jest.fn(() => ({})),
}));

// AdMob reaches native at import time. The mock also lets the frequency and
// suppression rules be tested without an SDK.
jest.mock('react-native-google-mobile-ads', () => {
  const listeners: ((event: { type: string; payload?: unknown }) => void)[] = [];
  const mockAd = {
    load: jest.fn(() => {
      // Mimic a successful load on the next tick.
      for (const listener of listeners) listener({ type: 'loaded' });
    }),
    // Models the user dismissing the ad, which is what always happens and is
    // what clears the "currently showing" guard in the service.
    show: jest.fn(() => {
      for (const listener of [...listeners]) listener({ type: 'closed' });
    }),
    addAdEventsListener: jest.fn(
      (handler: (event: { type: string; payload?: unknown }) => void) => {
        listeners.push(handler);
        return () => {
          const index = listeners.indexOf(handler);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
    ),
  };

  return {
    __esModule: true,
    default: () => ({
      initialize: jest.fn(async () => []),
      setRequestConfiguration: jest.fn(async () => undefined),
    }),
    AdEventType: {
      LOADED: 'loaded',
      ERROR: 'error',
      CLOSED: 'closed',
      OPENED: 'opened',
    },
    AdsConsent: {
      requestInfoUpdate: jest.fn(async () => ({
        status: 'notRequired',
        isConsentFormAvailable: false,
      })),
      gatherConsent: jest.fn(async () => undefined),
    },
    AdsConsentStatus: { REQUIRED: 'required', NOT_REQUIRED: 'notRequired' },
    MaxAdContentRating: { PG: 'PG' },
    InterstitialAd: { createForAdRequest: jest.fn(() => mockAd) },
    BannerAd: 'BannerAd',
    BannerAdSize: {
      BANNER: 'BANNER',
      ANCHORED_ADAPTIVE_BANNER: 'ANCHORED_ADAPTIVE_BANNER',
    },
    TestIds: { INTERSTITIAL: 'test-interstitial', BANNER: 'test-banner' },
    __mockAd: mockAd,
  };
});

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    throw new Error('SQLite is not available in tests; mock the repository');
  },
}));

// The three FortShare TurboModules. Individual tests override what they need.
jest.mock('../src/native/specs/NativeFortShareNet', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('../src/native/specs/NativeFortShareFs', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('../src/native/specs/NativeFortShareNotify', () => ({
  __esModule: true,
  default: {},
}));
