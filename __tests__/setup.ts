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
