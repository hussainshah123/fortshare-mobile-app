import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme';
import { Button, Icon, Sheet, Text } from '../ui';
import type { IconName } from '../ui';
import { DeviceDiscovery } from '../../native';
import { requestWifiDirectAccess } from '../../services/permissions';
import {
  checkReadiness,
  gaps,
  watchReadiness,
  type ReadinessGap,
  type ReadinessState,
} from '../../services/readiness';

/**
 * "Turn these on to share" — asked once, at launch.
 *
 * FortShare needs two things from the OS: the **Wi-Fi radio**, and — only to
 * scan for nearby devices — the **Location** toggle. It uses no Bluetooth and
 * no internet, so neither is checked and neither is ever requested.
 *
 * The reason to ask now rather than at the point of failure is that both are
 * otherwise silent and resurface much later wearing a disguise. Wi-Fi off
 * becomes "no address" and a screen that sits on "waiting". Location off
 * makes Android quietly refuse to scan, and `discoverPeers` fails with a bare
 * internal error that names nothing anyone could act on. Asked up front, each
 * is one sentence and one tap.
 *
 * Dismissible on purpose. Only the Wi-Fi radio is truly required; Location
 * and the permission gate *scanning* alone, and a QR code still pairs two
 * devices without either. Blocking the app over something it can work around
 * would be a lie about its own capabilities.
 */
export function ReadinessPrompt() {
  const theme = useTheme();
  const [state, setState] = useState<ReadinessState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState<ReadinessGap | null>(null);

  useEffect(() => {
    void checkReadiness().then(setState);
    // Every fix happens outside the app, so coming back is exactly when the
    // answer has changed.
    return watchReadiness((next) => {
      setState(next);
      // Something was fixed: allow the sheet to speak again if the user
      // switches one of them back off later.
      if (next.ready) setDismissed(false);
    });
  }, []);

  const fix = useCallback(async (gap: ReadinessGap) => {
    setBusy(gap);
    try {
      if (gap === 'permission') {
        await requestWifiDirectAccess();
      } else {
        await DeviceDiscovery.openSystemSetting(gap);
      }
      // Older Android can switch Wi-Fi on in place, so re-check immediately
      // rather than waiting for a return to the foreground that never comes.
      setState(await checkReadiness());
    } finally {
      setBusy(null);
    }
  }, []);

  if (!state || state.ready || dismissed) return null;
  const missing = gaps(state);

  return (
    <Sheet
      visible
      title="Turn these on to share"
      subtitle="FortShare works with no internet — but it does need the radio."
      onClose={() => setDismissed(true)}
    >
      <View style={{ gap: theme.spacing.sm }}>
        {missing.map((gap) => (
          <Requirement
            key={gap}
            gap={gap}
            busy={busy === gap}
            onFix={() => void fix(gap)}
          />
        ))}
      </View>

      <View
        style={{
          flexDirection: 'row',
          gap: theme.spacing.sm,
          marginTop: theme.spacing.lg,
          alignItems: 'flex-start',
        }}
      >
        <Icon name="shield" size={15} color={theme.colors.textFaint} />
        <Text variant="caption" tone="faint" style={{ flex: 1 }}>
          FortShare never uses your location, and never connects to the
          internet to move a file. Android requires the Location toggle before
          any app may scan for nearby devices — that is the only reason it is
          here.
        </Text>
      </View>

      <Button
        label="Not now"
        variant="ghost"
        onPress={() => setDismissed(true)}
        style={{ marginTop: theme.spacing.sm }}
      />
    </Sheet>
  );
}

const COPY: Record<
  ReadinessGap,
  { icon: IconName; title: string; detail: string; action: string }
> = {
  wifi: {
    icon: 'wifi',
    title: 'Wi-Fi',
    detail:
      'Needs to be switched on. It does not have to be connected to a network, and no internet is used.',
    action: 'Turn on',
  },
  location: {
    icon: 'alert',
    title: 'Location',
    detail:
      'Android will not let any app scan for nearby devices while this is off. Your position is never read.',
    action: 'Open settings',
  },
  permission: {
    icon: 'phone',
    title: 'Nearby devices',
    detail:
      'The permission that lets FortShare see the phones around you, so you can send without typing an address.',
    action: 'Allow',
  },
};

function Requirement({
  gap,
  busy,
  onFix,
}: {
  gap: ReadinessGap;
  busy: boolean;
  onFix: () => void;
}) {
  const theme = useTheme();
  const copy = COPY[gap];

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        padding: theme.spacing.md,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.surfaceAlt,
      }}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: theme.radius.sm,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.warningSoft,
        }}
      >
        <Icon name={copy.icon} size={18} color={theme.colors.warning} />
      </View>

      <View style={{ flex: 1 }}>
        <Text variant="bodyMedium">{copy.title}</Text>
        <Text variant="caption" tone="muted">
          {copy.detail}
        </Text>
      </View>

      <Button label={copy.action} variant="secondary" loading={busy} onPress={onFix} />
    </View>
  );
}
