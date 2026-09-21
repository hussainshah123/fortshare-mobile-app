import { gapsIn } from '../src/services/readiness';
import type { SystemReadiness } from '../src/native/DeviceDiscovery';

/**
 * What the app asks the user to switch on at launch.
 *
 * FortShare needs the Wi-Fi radio, and — only in order to scan — the system
 * Location toggle. It uses no Bluetooth and no internet, so neither is
 * checked and neither is ever requested. Getting this list wrong in either
 * direction is costly: asking for something unnecessary teaches people to
 * dismiss the prompt, and failing to ask produces the silent failures this
 * whole prompt exists to prevent.
 */

function android(overrides: Partial<SystemReadiness> = {}): SystemReadiness {
  return {
    wifiEnabled: true,
    locationEnabled: true,
    locationRequired: true,
    canEnableWifiDirectly: false,
    ...overrides,
  };
}

describe('nothing to ask for', () => {
  it('stays silent when everything is already on', () => {
    expect(gapsIn(android(), true)).toEqual([]);
  });
});

describe('what is missing', () => {
  it('asks for Wi-Fi when the radio is off', () => {
    expect(gapsIn(android({ wifiEnabled: false }), true)).toEqual(['wifi']);
  });

  it('asks for Location when scanning needs it', () => {
    expect(gapsIn(android({ locationEnabled: false }), true)).toEqual(['location']);
  });

  it('asks for the nearby-devices permission when it is not granted', () => {
    expect(gapsIn(android(), false)).toEqual(['permission']);
  });

  it('puts Wi-Fi first, because nothing at all works without the radio', () => {
    const missing = gapsIn(
      android({ wifiEnabled: false, locationEnabled: false }),
      false,
    );
    expect(missing).toEqual(['wifi', 'location', 'permission']);
  });
});

describe('what is never asked for', () => {
  it('does not ask for Location where scanning does not need it', () => {
    // iOS: AWDL needs no Location toggle, so raising it there would be a
    // prompt the user cannot act on and does not need.
    const ios = android({ locationRequired: false, locationEnabled: false });
    expect(gapsIn(ios, true)).toEqual([]);
  });

  it('never asks for Bluetooth or internet', () => {
    // Neither is used anywhere in the app. This test exists so that adding
    // either to the prompt has to be a deliberate decision, not a drift.
    const everything = gapsIn(
      android({ wifiEnabled: false, locationEnabled: false }),
      false,
    );
    expect(everything).not.toContain('bluetooth');
    expect(everything).not.toContain('internet');
  });
});
