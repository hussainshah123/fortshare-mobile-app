// Date formatting is calendar-day based and therefore timezone-sensitive.
// Pinning UTC keeps those tests identical on every machine and in CI.
process.env.TZ = 'UTC';

module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/__tests__/setup.ts'],
  testPathIgnorePatterns: [
    '<rootDir>/__tests__/setup.ts',
    '<rootDir>/__tests__/mocks/',
  ],
  // @noble/curves and @noble/hashes are ESM-only, so they must be transformed
  // rather than ignored like the rest of node_modules.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@noble)/)',
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/native/specs/**',
  ],
};
