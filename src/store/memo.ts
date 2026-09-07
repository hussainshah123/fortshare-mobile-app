/**
 * Single-entry memoisation for derived store selectors.
 *
 * Zustand v5 reads selectors through `useSyncExternalStore`, which calls the
 * selector on every render and compares the result with `Object.is`. A
 * selector that *derives* something — joining two slices, filtering a list,
 * summing totals — returns a fresh array or object each call, so the
 * comparison always fails, React concludes the store changed, and re-renders
 * forever. React reports this as:
 *
 *   "The result of getSnapshot should be cached to avoid an infinite loop"
 *
 * `useShallow` does not solve it when the derived value contains freshly
 * built objects, because a shallow compare still sees new element references.
 * The fix has to be at the derivation: return the *same* instance while the
 * inputs are unchanged.
 *
 * One entry is enough because these selectors are driven by store slices that
 * are replaced wholesale on every update, so the previous call's arguments are
 * the only ones worth caching.
 */
export function memoizeSelector<Args extends readonly unknown[], R>(
  compute: (...args: Args) => R,
): (...args: Args) => R {
  let lastArgs: Args | null = null;
  let lastResult: R;

  return (...args: Args): R => {
    if (
      lastArgs !== null &&
      lastArgs.length === args.length &&
      lastArgs.every((value, index) => Object.is(value, args[index]))
    ) {
      return lastResult;
    }
    lastArgs = args;
    lastResult = compute(...args);
    return lastResult;
  };
}
