import { Platform } from 'react-native';
import { TestIds } from 'react-native-google-mobile-ads';

/**
 * AdMob configuration.
 *
 * Note what this costs: FortShare's file transfer is fully offline and speaks
 * to no server, and that remains true — but the ad SDK does contact Google.
 * Everything in services/ads.ts is therefore written so that ad failures are
 * invisible: no network, no consent, blocked SDK, all mean "no ad shown" and
 * nothing else. The core product must never depend on it.
 */

/**
 * Real unit IDs are used only in release builds.
 *
 * Requesting real ads from a development build inflates impressions against
 * traffic that will never convert, and repeated debug requests are a common
 * way to get an AdMob account flagged for invalid traffic. Google publishes
 * test units precisely for this.
 */
export const AD_UNIT_INTERSTITIAL = __DEV__
  ? TestIds.INTERSTITIAL
  : 'ca-app-pub-9318693466829633/2712885630';

/**
 * Banner unit.
 *
 * **This needs its own ad unit — it is not configured yet.**
 *
 * A banner cannot reuse the interstitial unit: AdMob ties each unit to one
 * format, and requesting a banner against an interstitial unit returns a
 * no-fill every time. Create an "Interstitial → no, **Banner**" unit in the
 * AdMob console and paste the id below.
 *
 * Until then this stays empty in release builds and `AdBanner` renders
 * nothing, rather than shipping a request that is guaranteed to fail.
 * Development builds use Google's test unit so the placement can be seen.
 */
export const AD_UNIT_BANNER = __DEV__ ? TestIds.BANNER : '';

/** Kept for reference; the app id is injected at build time from app.json. */
export const AD_APP_ID = 'ca-app-pub-9318693466829633~6045143487';

/**
 * Minimum gap between two interstitials.
 *
 * A full-screen ad after every single action would make the app hostile to
 * use, and AdMob's own policies treat accidental or excessive interstitials as
 * a violation. Ten minutes is deliberately conservative.
 */
export const INTERSTITIAL_MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * How many completed transfers before the first ad of a session.
 *
 * The first transfer a user ever does is the moment they decide whether this
 * app works. Interrupting that with an ad is the worst possible trade.
 */
export const INTERSTITIAL_TRANSFERS_BEFORE_FIRST = 1;

/**
 * How long the app must have been open before a Home-screen ad may appear.
 *
 * An interstitial that fires as the app opens is what AdMob's policies call an
 * unexpected interstitial, and it is a documented cause of account
 * enforcement — Google has a separate format (App Open ads) for that moment.
 * Requiring the session to be a little way in keeps this a *navigation* ad
 * rather than a launch ad.
 */
export const HOME_AD_MIN_SESSION_MS = 20 * 1000;

/**
 * Delay after Home gains focus before showing.
 *
 * Long enough that the screen has painted: an ad thrown over a half-rendered
 * screen reads as a crash, and the user cannot tell what they are dismissing.
 */
export const HOME_AD_SETTLE_MS = 1200;

/** iOS needs the tracking prompt before personalised ads are permitted. */
export const REQUESTS_TRACKING_CONSENT = Platform.OS === 'ios';
