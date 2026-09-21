import {
  adDebugState,
  backdateSessionForTests,
  initialiseAds,
  maybeShowInterstitial,
  maybeShowOnHomeScreen,
  noteTransferCompleted,
  resetAdStateForTests,
} from '../src/services/ads';
import {
  AD_APP_ID,
  AD_UNIT_BANNER,
  AD_UNIT_INTERSTITIAL,
  HOME_AD_MIN_SESSION_MS,
  INTERSTITIAL_MIN_INTERVAL_MS,
} from '../src/constants/ads';

/**
 * Ad behaviour rules.
 *
 * These matter more than most tests here, because the failure modes are
 * user-hostile rather than merely broken: an interstitial that covers a
 * running transfer hides the progress bar and any pairing prompt, and one that
 * fires on a user's first-ever transfer is the worst possible first impression.
 *
 * The other rule being pinned is that ad failures stay invisible — the whole
 * point of a local-first file-sharing app is that it works with the internet
 * off, and nothing here may compromise that.
 */

const admob = require('react-native-google-mobile-ads') as {
  __mockAd: { show: jest.Mock; load: jest.Mock };
  InterstitialAd: { createForAdRequest: jest.Mock };
  AdsConsent: { requestInfoUpdate: jest.Mock };
};

beforeEach(async () => {
  jest.clearAllMocks();
  resetAdStateForTests();
  await initialiseAds();
});

describe('never interrupting a transfer', () => {
  it('refuses to show while a transfer is running', () => {
    noteTransferCompleted();
    // An ad here would cover a live progress bar and any incoming-file prompt.
    expect(maybeShowInterstitial({ hasActiveTransfer: true })).toBe(false);
    expect(admob.__mockAd.show).not.toHaveBeenCalled();
  });

  it('shows once nothing is running', () => {
    noteTransferCompleted();
    expect(maybeShowInterstitial({ hasActiveTransfer: false })).toBe(true);
    expect(admob.__mockAd.show).toHaveBeenCalledTimes(1);
  });
});

describe('frequency', () => {
  it('does not fire before the first transfer completes', () => {
    // A brand new user has not seen the app work yet.
    expect(maybeShowInterstitial({ hasActiveTransfer: false })).toBe(false);
    expect(admob.__mockAd.show).not.toHaveBeenCalled();
  });

  it('enforces a minimum gap between ads', () => {
    noteTransferCompleted();
    expect(maybeShowInterstitial({ hasActiveTransfer: false })).toBe(true);

    // Immediately afterwards, even with more transfers, it must not fire.
    noteTransferCompleted();
    expect(maybeShowInterstitial({ hasActiveTransfer: false })).toBe(false);
    expect(admob.__mockAd.show).toHaveBeenCalledTimes(1);
  });

  it('allows another once the interval has passed', () => {
    jest.useFakeTimers().setSystemTime(0);
    try {
      noteTransferCompleted();
      expect(maybeShowInterstitial({ hasActiveTransfer: false })).toBe(true);

      // Still inside the window: refused.
      jest.setSystemTime(INTERSTITIAL_MIN_INTERVAL_MS - 1);
      noteTransferCompleted();
      expect(maybeShowInterstitial({ hasActiveTransfer: false })).toBe(false);

      // Past the window: allowed again.
      jest.setSystemTime(INTERSTITIAL_MIN_INTERVAL_MS + 1);
      expect(maybeShowInterstitial({ hasActiveTransfer: false })).toBe(true);
      expect(admob.__mockAd.show).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('failures stay invisible', () => {
  it('survives an SDK that cannot initialise', async () => {
    resetAdStateForTests();
    admob.AdsConsent.requestInfoUpdate.mockRejectedValueOnce(
      new Error('no network'),
    );
    admob.InterstitialAd.createForAdRequest.mockImplementationOnce(() => {
      throw new Error('sdk unavailable');
    });

    // Must resolve, not reject: this runs during app startup, and a rejected
    // promise here would surface as a boot failure for an offline-first app.
    await expect(initialiseAds()).resolves.toBeUndefined();
    expect(maybeShowInterstitial({ hasActiveTransfer: false })).toBe(false);
  });

  it('reports no ad rather than throwing when show fails', () => {
    noteTransferCompleted();
    admob.__mockAd.show.mockImplementationOnce(() => {
      throw new Error('not ready');
    });
    expect(() =>
      maybeShowInterstitial({ hasActiveTransfer: false }),
    ).not.toThrow();
  });

  it('counts completed transfers even when no ad is available', () => {
    resetAdStateForTests();
    noteTransferCompleted();
    noteTransferCompleted();
    expect(adDebugState().completedTransfers).toBe(2);
  });
});

/**
 * The Home-screen placement.
 *
 * The launch guard here is not a UX nicety: an interstitial that fires as the
 * app opens is what AdMob's policies call an unexpected interstitial, and it
 * is a documented cause of account enforcement. Google's format for that
 * moment is an App Open ad, not this. So the guard protects the account, and
 * is worth a test that fails loudly if someone removes it.
 */
describe('home screen placement', () => {
  it('refuses in the first seconds of a session', () => {
    // A cold start must never produce an interstitial.
    expect(maybeShowOnHomeScreen({ hasActiveTransfer: false })).toBe(false);
    expect(admob.__mockAd.show).not.toHaveBeenCalled();
  });

  it('shows once the session is past the launch window', () => {
    backdateSessionForTests(HOME_AD_MIN_SESSION_MS + 1000);
    expect(maybeShowOnHomeScreen({ hasActiveTransfer: false })).toBe(true);
    expect(admob.__mockAd.show).toHaveBeenCalledTimes(1);
  });

  it('does not require a completed transfer, unlike the other placement', () => {
    backdateSessionForTests(HOME_AD_MIN_SESSION_MS + 1000);
    // Zero completed transfers — the transfer placement would refuse here.
    expect(adDebugState().completedTransfers).toBe(0);
    expect(maybeShowOnHomeScreen({ hasActiveTransfer: false })).toBe(true);
  });

  it('still refuses while a transfer is running', () => {
    backdateSessionForTests(HOME_AD_MIN_SESSION_MS + 1000);
    expect(maybeShowOnHomeScreen({ hasActiveTransfer: true })).toBe(false);
    expect(admob.__mockAd.show).not.toHaveBeenCalled();
  });

  it('shares the frequency cap with the transfer placement', () => {
    backdateSessionForTests(HOME_AD_MIN_SESSION_MS + 1000);
    expect(maybeShowOnHomeScreen({ hasActiveTransfer: false })).toBe(true);

    // Returning to Home repeatedly must not produce an ad each time.
    expect(maybeShowOnHomeScreen({ hasActiveTransfer: false })).toBe(false);

    // And a transfer finishing right after must not bypass the cap either.
    noteTransferCompleted();
    expect(maybeShowInterstitial({ hasActiveTransfer: false })).toBe(false);
    expect(admob.__mockAd.show).toHaveBeenCalledTimes(1);
  });

  it('allows another after the interval', () => {
    jest.useFakeTimers().setSystemTime(1_000_000);
    try {
      backdateSessionForTests(HOME_AD_MIN_SESSION_MS + 1000);
      expect(maybeShowOnHomeScreen({ hasActiveTransfer: false })).toBe(true);

      jest.setSystemTime(1_000_000 + INTERSTITIAL_MIN_INTERVAL_MS + 1);
      expect(maybeShowOnHomeScreen({ hasActiveTransfer: false })).toBe(true);
      expect(admob.__mockAd.show).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * The IDs that actually ship.
 *
 * These are account-level identifiers: a typo does not fail to build, it
 * simply earns nothing, silently, for as long as nobody checks. And a test
 * unit left in a release build serves fake ads that pay nothing at all —
 * which is exactly as invisible. So both are pinned here.
 */
describe('ad unit configuration', () => {
  it('ships the live publisher account', () => {
    expect(AD_APP_ID).toBe('ca-app-pub-4687548663016677~8618302099');
    expect(AD_UNIT_INTERSTITIAL.startsWith('ca-app-pub-4687548663016677/')).toBe(
      true,
    );
  });

  it('never ships a Google test unit', () => {
    // Test units are the string "ca-app-pub-3940256099942544/..." — Google's
    // public sample account. Shipping one means zero revenue with no error.
    expect(AD_UNIT_INTERSTITIAL).not.toContain('3940256099942544');
    expect(AD_UNIT_BANNER).not.toContain('3940256099942544');
  });

  it('does not point the banner at the interstitial unit', () => {
    // AdMob ties a unit to one format: a banner request against an
    // interstitial unit no-fills every time. Empty is correct until a real
    // banner unit exists; reusing the interstitial id would not be.
    if (AD_UNIT_BANNER) {
      expect(AD_UNIT_BANNER).not.toBe(AD_UNIT_INTERSTITIAL);
    }
  });
});
