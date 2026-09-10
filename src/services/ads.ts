import mobileAds, {
  AdEventType,
  AdsConsent,
  AdsConsentStatus,
  InterstitialAd,
  MaxAdContentRating,
} from 'react-native-google-mobile-ads';
import {
  AD_UNIT_INTERSTITIAL,
  HOME_AD_MIN_SESSION_MS,
  INTERSTITIAL_MIN_INTERVAL_MS,
  INTERSTITIAL_TRANSFERS_BEFORE_FIRST,
} from '../constants/ads';
import { logger } from './log';

const log = logger('ads');

/**
 * Interstitial ads.
 *
 * The governing rule: **an ad must never be able to affect a transfer.** Every
 * call here is fire-and-forget and swallows its own failures, because the
 * alternative — a rejected promise from an SDK that talks to Google — would
 * propagate into a code path whose entire promise is that it works with the
 * internet switched off.
 *
 * So: no network, no consent, SDK blocked, unit misconfigured — all resolve to
 * "no ad shown", and nothing else changes.
 */

let initialised = false;
let interstitial: InterstitialAd | null = null;
let loaded = false;
let showing = false;
/**
 * `-1` means "never shown".
 *
 * A zero sentinel is ambiguous, because `Date.now()` can legitimately be 0
 * (and is, under fake timers), making "never shown" indistinguishable from
 * "just shown". The same trap was already fixed once in SpeedTracker.
 */
const NEVER_SHOWN = -1;
let lastShownAt = NEVER_SHOWN;
let completedTransfers = 0;
let unsubscribe: (() => void) | null = null;
/** When this app session started, for the Home placement's launch guard. */
let sessionStartedAt = Date.now();

/**
 * Start the SDK and pre-load the first ad.
 *
 * Called after the app is usable, never before: initialisation does network
 * I/O, and nothing about it should sit in front of the first render or delay
 * the TCP listener coming up.
 */
export async function initialiseAds(): Promise<void> {
  if (initialised) return;
  initialised = true;

  try {
    await requestConsent();

    await mobileAds().setRequestConfiguration({
      // FortShare is a general-purpose utility; keep ad content in line with
      // the audience the store listing implies.
      maxAdContentRating: MaxAdContentRating.PG,
      tagForChildDirectedTreatment: false,
      tagForUnderAgeOfConsent: false,
    });

    await mobileAds().initialize();
    log.info('ad sdk initialised');
    preload();
  } catch (error) {
    // Deliberately terminal-but-silent: ads simply will not appear.
    log.warn('ad sdk unavailable — continuing without ads', error);
  }
}

/**
 * Ask for consent where the law requires it (EEA/UK).
 *
 * Personalised ads without consent is a legal problem, not a UX preference.
 * A failure here is treated as "no consent", which still permits
 * non-personalised ads and never blocks the app.
 */
async function requestConsent(): Promise<void> {
  try {
    const info = await AdsConsent.requestInfoUpdate();
    if (
      info.status === AdsConsentStatus.REQUIRED ||
      info.isConsentFormAvailable
    ) {
      await AdsConsent.gatherConsent();
      log.debug('consent flow completed');
    }
  } catch (error) {
    log.debug('consent unavailable — non-personalised ads only', error);
  }
}

/**
 * Load an interstitial in the background so showing it is instant.
 *
 * An ad requested at the moment it is wanted arrives too late and shows over
 * the *next* screen, which is exactly how interstitials become the thing users
 * hate.
 */
function preload(): void {
  if (!initialised || loaded || showing) return;

  try {
    unsubscribe?.();
    const ad = InterstitialAd.createForAdRequest(AD_UNIT_INTERSTITIAL, {
      requestNonPersonalizedAdsOnly: false,
    });

    const stopListening = ad.addAdEventsListener(({ type, payload }) => {
      switch (type) {
        case AdEventType.LOADED:
          loaded = true;
          log.debug('interstitial ready');
          break;
        case AdEventType.ERROR:
          loaded = false;
          log.debug('interstitial failed to load', payload);
          break;
        case AdEventType.CLOSED:
          // Immediately queue the next one; the interval cap decides when it
          // may actually be shown.
          loaded = false;
          showing = false;
          preload();
          break;
        default:
          break;
      }
    });

    unsubscribe = stopListening;
    interstitial = ad;
    ad.load();
  } catch (error) {
    log.debug('could not create interstitial', error);
    loaded = false;
  }
}

/**
 * Show an interstitial on returning to Home, if one is due.
 *
 * Separate from the transfer placement because the rules differ. This one has
 * no "wait for a completed transfer" gate — a user browsing the app should be
 * monetisable — but it does have a launch guard the other does not need:
 * firing as the app opens is an unexpected interstitial under AdMob's
 * policies, and the correct format for that moment is an App Open ad.
 */
export function maybeShowOnHomeScreen(options: {
  hasActiveTransfer: boolean;
}): boolean {
  if (Date.now() - sessionStartedAt < HOME_AD_MIN_SESSION_MS) {
    log.debug('home ad suppressed — too early in the session');
    return false;
  }
  if (!loaded || showing) return false;
  if (options.hasActiveTransfer) return false;
  if (lastShownAt !== NEVER_SHOWN &&
      Date.now() - lastShownAt < INTERSTITIAL_MIN_INTERVAL_MS) {
    return false;
  }

  try {
    showing = true;
    lastShownAt = Date.now();
    interstitial?.show();
    log.info('interstitial shown (home)');
    return true;
  } catch (error) {
    showing = false;
    log.debug('home interstitial could not be shown', error);
    preload();
    return false;
  }
}

/**
 * Whether an ad may be shown right now.
 *
 * The transfer check is the important one. An interstitial covers the screen
 * and takes focus, and doing that over a running transfer would hide progress,
 * hide a pairing prompt, and make the app feel broken at precisely the moment
 * it is doing its job.
 */
function mayShow(hasActiveTransfer: boolean): boolean {
  if (!loaded || showing) return false;
  if (hasActiveTransfer) return false;
  if (completedTransfers < INTERSTITIAL_TRANSFERS_BEFORE_FIRST) return false;
  if (lastShownAt === NEVER_SHOWN) return true;
  return Date.now() - lastShownAt >= INTERSTITIAL_MIN_INTERVAL_MS;
}

/**
 * Show an interstitial at a natural break, if one is due.
 *
 * Returns whether it was shown, so callers can log it — but no caller should
 * ever change behaviour based on the answer.
 */
export function maybeShowInterstitial(options: {
  /** True while any transfer is running; suppresses the ad entirely. */
  hasActiveTransfer: boolean;
}): boolean {
  if (!mayShow(options.hasActiveTransfer)) return false;

  try {
    showing = true;
    lastShownAt = Date.now();
    interstitial?.show();
    log.info('interstitial shown');
    return true;
  } catch (error) {
    showing = false;
    log.debug('interstitial could not be shown', error);
    preload();
    return false;
  }
}

/**
 * Record that a transfer finished.
 *
 * Counted separately from showing an ad so the "not on the user's first
 * transfer" rule survives an ad failing to load.
 */
export function noteTransferCompleted(): void {
  completedTransfers += 1;
}

/** Test hook: reset the module's frequency state. */
export function resetAdStateForTests(): void {
  initialised = false;
  loaded = false;
  showing = false;
  lastShownAt = NEVER_SHOWN;
  completedTransfers = 0;
  sessionStartedAt = Date.now();
  unsubscribe?.();
  unsubscribe = null;
  interstitial = null;
}

export function adDebugState(): {
  initialised: boolean;
  loaded: boolean;
  completedTransfers: number;
  msSinceLastShown: number | null;
  sessionAgeMs: number;
} {
  return {
    initialised,
    loaded,
    completedTransfers,
    msSinceLastShown:
      lastShownAt === NEVER_SHOWN ? null : Date.now() - lastShownAt,
    sessionAgeMs: Date.now() - sessionStartedAt,
  };
}

/** Test hook: pretend the session started longer ago. */
export function backdateSessionForTests(ms: number): void {
  sessionStartedAt = Date.now() - ms;
}
