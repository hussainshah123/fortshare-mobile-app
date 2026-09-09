import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme';
import { Button, Card, Icon, Text } from '../ui';
import { useDeviceStore, useUiStore } from '../../store';
import { DiscoveryService } from '../../network/discovery/DiscoveryService';

/**
 * The Wi-Fi Direct control (§8).
 *
 * Exists because the local-network path has a failure the app cannot fix from
 * the inside: a router with AP/client isolation still forwards mDNS multicast,
 * so both devices *see* each other, but unicast TCP between them is dropped
 * and the connection fails with "no route to host". Same subnet, still
 * unreachable.
 *
 * Wi-Fi Direct removes the router from the path entirely, which also covers
 * two devices on different networks or on none at all.
 *
 * Deliberately opt-in rather than always on: it needs a permission the normal
 * path does not (location, below Android 13), and forming a P2P group can
 * disturb the device's Wi-Fi connection. Someone whose router works normally
 * should never have to think about it — so the panel only insists when a
 * connection has actually been blocked.
 */
export function WifiDirectPanel({ blocked = false }: { blocked?: boolean }) {
  const theme = useTheme();
  const toast = useUiStore((state) => state.toast);
  const wifiDirect = useDeviceStore((state) => state.wifiDirect);
  const toggle = useDeviceStore((state) => state.toggleWifiDirect);

  const [busy, setBusy] = useState(false);

  // Checked once so an unsupported device can say so instead of offering a
  // switch that would fail.
  useEffect(() => {
    void DiscoveryService.wifiDirectSupport().catch(() => undefined);
  }, []);

  const onToggle = useCallback(async () => {
    setBusy(true);
    const result = await toggle(!wifiDirect.enabled);
    setBusy(false);

    if (!result.ok && result.message) {
      toast(result.message, 'error');
      return;
    }
    if (!wifiDirect.enabled) {
      toast('Wi-Fi Direct on — looking for devices without the router', 'success');
    }
  }, [toggle, wifiDirect.enabled, toast]);

  // Nothing useful to offer on hardware that cannot do it (including iOS,
  // where Apple's own peer-to-peer is already used automatically).
  if (
    !wifiDirect.supported &&
    !wifiDirect.enabled &&
    wifiDirect.unsupportedReason &&
    wifiDirect.unsupportedReason !== 'permission-required'
  ) {
    if (!blocked) return null;
    return (
      <Card style={{ marginTop: theme.spacing.md }}>
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
          <Icon name="alert" size={16} color={theme.colors.textFaint} />
          <Text variant="caption" tone="faint" style={{ flex: 1 }}>
            {wifiDirect.unsupportedReason} Share a hotspot from one device
            instead — that bypasses the router too.
          </Text>
        </View>
      </Card>
    );
  }

  const active = wifiDirect.enabled;

  return (
    <Card
      style={{
        marginTop: theme.spacing.md,
        borderColor: blocked && !active ? theme.colors.warning : theme.colors.border,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
        }}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: theme.radius.sm,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: active
              ? theme.colors.successSoft
              : theme.colors.surfaceAlt,
          }}
        >
          <Icon
            name="wifi"
            size={18}
            color={active ? theme.colors.success : theme.colors.textMuted}
          />
        </View>

        <View style={{ flex: 1 }}>
          <Text variant="bodyMedium">Wi-Fi Direct</Text>
          <Text variant="caption" tone="muted">
            {active
              ? wifiDirect.connected
                ? 'Connected directly — no router involved'
                : 'On — finding devices without the router'
              : 'Connect without a router or hotspot'}
          </Text>
        </View>

        <Button
          label={active ? 'Turn off' : 'Turn on'}
          variant={active ? 'secondary' : blocked ? 'primary' : 'secondary'}
          loading={busy}
          onPress={() => void onToggle()}
        />
      </View>

      {/*
        Shown only once a connection has actually been blocked. Explaining AP
        isolation to someone whose network works fine is noise; explaining it
        to someone staring at a failure is the whole answer.
      */}
      {blocked && !active ? (
        <View
          style={{
            flexDirection: 'row',
            gap: theme.spacing.sm,
            marginTop: theme.spacing.md,
            paddingTop: theme.spacing.md,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
          }}
        >
          <Icon name="alert" size={15} color={theme.colors.warning} />
          <Text variant="caption" tone="warning" style={{ flex: 1 }}>
            Your Wi-Fi can see the other device but is blocking the two from
            connecting — routers call this "AP isolation". Wi-Fi Direct goes
            around it completely.
          </Text>
        </View>
      ) : null}

      {active ? (
        <Text variant="caption" tone="faint" style={{ marginTop: theme.spacing.md }}>
          Devices found this way appear in the list above. Your normal Wi-Fi
          keeps working — no internet is needed either way.
        </Text>
      ) : null}
    </Card>
  );
}
