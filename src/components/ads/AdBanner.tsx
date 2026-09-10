import React, { useState } from 'react';
import { View } from 'react-native';
import { BannerAd, BannerAdSize } from 'react-native-google-mobile-ads';
import { AD_UNIT_BANNER } from '../../constants/ads';
import { useTransferStore } from '../../store';
import { logger } from '../../services/log';

const log = logger('ads');

/**
 * An inline banner ad.
 *
 * Unlike the interstitial this is always visible rather than interrupting, so
 * it needs no frequency cap — but it keeps the same rule that matters:
 * **nothing to do with ads may intrude on a transfer.** While one is running
 * the banner is unmounted, so it cannot reflow the screen or steal a tap
 * meant for Pause.
 *
 * Renders nothing at all when unconfigured, unloaded or failed — so a missing
 * unit id, an offline device or a no-fill leaves no empty gap and no
 * placeholder text behind.
 */
export function AdBanner() {
  const activeCount = useTransferStore((state) => state.active.size);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // No unit configured — see AD_UNIT_BANNER. Better to show nothing than to
  // fire a request that AdMob will always no-fill.
  if (!AD_UNIT_BANNER) return null;
  if (activeCount > 0) return null;
  if (failed) return null;

  return (
    <View
      style={{
        alignItems: 'center',
        // Height comes from the ad itself once it loads; nothing is reserved
        // before that, so an unfilled slot collapses instead of leaving a gap.
        height: loaded ? undefined : 0,
        overflow: 'hidden',
      }}
    >
      <BannerAd
        unitId={AD_UNIT_BANNER}
        // Adaptive rather than a fixed 320x50: it fills the device width and
        // is the size Google actually recommends for anchored placements.
        size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
        requestOptions={{ requestNonPersonalizedAdsOnly: false }}
        onAdLoaded={() => {
          setLoaded(true);
          setFailed(false);
        }}
        onAdFailedToLoad={(error) => {
          // Common and harmless: no fill, no network, or a brand-new unit that
          // AdMob has not started serving yet.
          log.debug('banner failed to load', error);
          setFailed(true);
        }}
      />
    </View>
  );
}
