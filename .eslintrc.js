module.exports = {
  root: true,
  extends: '@react-native',
  rules: {
    /**
     * FortShare styles from theme tokens, and the palette changes at runtime
     * with light/dark mode. `StyleSheet.create` cannot hold a value that
     * depends on the active theme, so themed styles are inline by necessity —
     * see src/theme/ThemeProvider.tsx.
     */
    'react-native/no-inline-styles': 'off',

    /**
     * `void somePromise()` is how this codebase marks a deliberately
     * un-awaited promise (a fire-and-forget refresh, a best-effort notify).
     * Flagging it would push the code towards silently floating promises,
     * which is strictly worse.
     */
    'no-void': 'off',
  },
  overrides: [
    {
      /**
       * Bit manipulation is the subject matter here: base64url, UTF-8 encoding
       * and the binary frame header are all defined in terms of shifts and
       * masks, and rewriting them arithmetically would be less readable and
       * less obviously correct.
       */
      files: ['src/services/crypto.ts', 'src/utils/*.ts'],
      rules: { 'no-bitwise': 'off' },
    },
  ],
};
