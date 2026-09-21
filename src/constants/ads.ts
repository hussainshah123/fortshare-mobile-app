import { Platform } from 'react-native';

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
 * The live interstitial unit, in every build.
 *
 * Test units were removed at the owner's request, so development builds now
 * request real ads too. Worth knowing what that costs: impressions served to
 * a debug build are traffic that can never convert, and repeated requests
 * from a development device are a documented way to have an AdMob account
 * flagged for invalid traffic. If enforcement ever becomes a concern, the fix
 * is to put `__DEV__ ? TestIds.INTERSTITIAL :` back in front of this.
 */
export const AD_UNIT_INTERSTITIAL = 'ca-app-pub-4687548663016677/13192';

/**
 * Banner unit.
 *
 * **Still not configured.** AdMob ties each unit to exactly one format, so a
 * banner cannot reuse the interstitial unit above — requesting one returns a
 * no-fill every single time. Create a unit of type **Banner** in the AdMob
 * console and paste its id here.
 *
 * Empty until then, which makes `AdBanner` render nothing at all rather than
 * ship a request guaranteed to fail.
 */
export const AD_UNIT_BANNER = '';

/** Kept for reference; the app id is injected at build time from app.json. */
export const AD_APP_ID = 'ca-app-pub-4687548663016677~8618302099';

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
