import { AppState, Platform } from 'react-native';
import { DeviceDiscovery } from '../native';
import type { SystemReadiness } from '../native/DeviceDiscovery';
import { hasWifiDirectAccess } from './permissions';
import { logger } from './log';

const log = logger('readiness');

/**
 * What the OS still needs switched on before sharing can work.
 *
 * FortShare needs exactly two things from the system: the **Wi-Fi radio**,
 * and — only in order to scan for nearby devices — the **Location** toggle.
 * It uses no Bluetooth and no internet, so neither is checked and neither is
 * ever requested.
 *
 * Asking at launch rather than at the point of failure is the whole value
 * here. Both of these are otherwise silent and surface much later disguised
 * as something else: Wi-Fi off becomes "no address" and an app that looks
 * stuck on "waiting"; Location off makes Android refuse to scan and
 * `discoverPeers` fail with a bare internal error naming nothing the user
 * could act on. Asked up front, each is one sentence and one tap.
 */
export interface ReadinessState extends SystemReadiness {
  /** The nearby-devices (or, below Android 13, location) permission. */
  hasPermission: boolean;
  /** Nothing is missing: the app can find and reach other devices. */
  ready: boolean;
}

/** Which requirements are unmet, in the order worth fixing them. */
export type ReadinessGap = 'wifi' | 'location' | 'permission';

export async function checkReadiness(): Promise<ReadinessState> {
  // iOS has nothing to ask for: Wi-Fi state is not readable without a special
  // entitlement, and AWDL needs no Location toggle.
  if (Platform.OS !== 'android') {
    return {
      wifiEnabled: true,
      locationEnabled: true,
      locationRequired: false,
      canEnableWifiDirectly: false,
      hasPermission: true,
      ready: true,
    };
  }

  const [system, hasPermission] = await Promise.all([
    DeviceDiscovery.systemReadiness().catch((error: unknown) => {
      log.debug('could not read system readiness', error);
      return null;
    }),
    hasWifiDirectAccess().catch(() => false),
  ]);

  // Unknown is treated as ready. A readiness check that cannot run must not
  // become a prompt the user can never dismiss.
  if (!system) {
    return {
      wifiEnabled: true,
      locationEnabled: true,
      locationRequired: false,
      canEnableWifiDirectly: false,
      hasPermission,
      ready: true,
    };
  }

  return { ...system, hasPermission, ready: gapsIn(system, hasPermission).length === 0 };
}

/**
 * What is missing, most blocking first.
 *
 * Wi-Fi comes first because nothing at all works without the radio. Location
 * and the permission only gate *scanning* — with both off, a QR code still
 * pairs two devices, which is why neither is presented as fatal.
 */
export function gapsIn(
  system: SystemReadiness,
  hasPermission: boolean,
): ReadinessGap[] {
  const missing: ReadinessGap[] = [];
  if (!system.wifiEnabled) missing.push('wifi');
  if (system.locationRequired && !system.locationEnabled) missing.push('location');
  if (!hasPermission) missing.push('permission');
  return missing;
}

export function gaps(state: ReadinessState): ReadinessGap[] {
  return gapsIn(state, state.hasPermission);
}

/**
 * Re-check whenever the app comes back to the foreground.
 *
 * Every fix for these happens outside the app — in Settings, or in a system
 * panel over it — so returning is exactly when the answer has changed. Without
 * this the prompt would still be there after the user did what it asked.
 */
export function watchReadiness(onChange: (state: ReadinessState) => void): () => void {
  const subscription = AppState.addEventListener('change', (status) => {
    if (status !== 'active') return;
    void checkReadiness().then(onChange);
  });
  return () => subscription.remove();
}
