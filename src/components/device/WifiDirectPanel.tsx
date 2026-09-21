import React, { useCallback, useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
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
  const candidates = useDeviceStore((state) => state.wifiDirectCandidates);
  const toggle = useDeviceStore((state) => state.toggleWifiDirect);
  const invite = useDeviceStore((state) => state.inviteWifiDirect);

  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState<string | null>(null);

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
    wifiDirect.unsupportedReason !== 'permission-required' &&
    wifiDirect.unsupportedReason !== 'wifi-off' &&
    wifiDirect.unsupportedReason !== 'location-off'
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
  /**
   * Location off is the single most common reason this feature appears
   * broken: scanning for nearby devices is a Wi-Fi scan, and Android refuses
   * to scan with the system toggle off — `discoverPeers` then fails with a
   * bare "internal error" that names nothing the user could act on.
   *
   * Hosting a group is not a scan, so the QR path still works; this says so
   * rather than leaving the feature looking dead.
   */
  const locationOff = wifiDirect.unsupportedReason === 'location-off';
  // Wi-Fi Direct rides the Wi-Fi radio: it needs Wi-Fi *on*, but not
  // connected to anything. Worth saying, because "turn Wi-Fi on" sounds
  // contradictory for a feature whose whole point is not needing a network.
  const wifiOff = wifiDirect.unsupportedReason === 'wifi-off';

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
            {wifiOff
              ? 'Turn Wi-Fi on — it need not be connected to anything'
              : locationOff
              ? 'Turn Location on so Android will scan for nearby devices'
              : active
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

      {/*
        Location off: actionable, and the one case where the fix is entirely
        outside the app.
      */}
      {locationOff ? (
        <View
          style={{
            marginTop: theme.spacing.md,
            paddingTop: theme.spacing.md,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            gap: theme.spacing.sm,
          }}
        >
          <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
            <Icon name="alert" size={15} color={theme.colors.warning} />
            <Text variant="caption" tone="warning" style={{ flex: 1 }}>
              Android will not scan for nearby devices while Location is off.
              It is not used for your position — only to find the other phone.
              You can also skip scanning entirely and pair with a QR code,
              which works either way.
            </Text>
          </View>
          <Button
            label="Open Location settings"
            variant="secondary"
            onPress={() => {
              void Linking.sendIntent(
                'android.settings.LOCATION_SOURCE_SETTINGS',
              ).catch(() => {
                void Linking.openSettings();
              });
            }}
          />
        </View>
      ) : null}

      {/* Whatever the P2P layer is currently waiting for. */}
      {wifiDirect.message && active ? (
        <View
          style={{
            flexDirection: 'row',
            gap: theme.spacing.sm,
            alignItems: 'center',
            marginTop: theme.spacing.md,
            padding: theme.spacing.md,
            borderRadius: theme.radius.sm,
            backgroundColor: theme.colors.accentSoft,
          }}
        >
          <Icon name="clock" size={15} color={theme.colors.accent} />
          <Text variant="caption" tone="accent" style={{ flex: 1 }}>
            {wifiDirect.message}
          </Text>
        </View>
      ) : null}

      {/*
        The nearby-device list.
        
        These come straight from Wi-Fi Direct, so they appear whether or not
        the other phone is running FortShare — Wi-Fi Direct is on whenever
        Wi-Fi is. Tapping one forms a group; once it is up, both devices share
        a 192.168.49.x network and ordinary discovery identifies the app.

        Requiring a FortShare service record *before* offering to connect was
        the flaw: when that record never arrived, the feature silently did
        nothing and there was no way to proceed.
      */}
      {active ? (
        <View style={{ marginTop: theme.spacing.md }}>
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
              paddingTop: theme.spacing.md,
            }}
          >
            <Text variant="label" tone="muted">
              NEARBY DEVICES
            </Text>

            {candidates.length === 0 ? (
              <Text
                variant="caption"
                tone="faint"
                style={{ marginTop: theme.spacing.sm }}
              >
                Looking… make sure the other phone has Wi-Fi switched on and is
                within a few metres. It does not need to be on the same network.
              </Text>
            ) : (
              candidates.map((peer) => {
                const unavailable = peer.status === 'unavailable';
                return (
                  <View
                    key={peer.address}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: theme.spacing.sm,
                      marginTop: theme.spacing.md,
                    }}
                  >
                    <Icon
                      name="phone"
                      size={16}
                      color={
                        peer.status === 'connected'
                          ? theme.colors.success
                          : theme.colors.textMuted
                      }
                    />
                    <View style={{ flex: 1 }}>
                      <Text variant="bodyMedium" numberOfLines={1}>
                        {peer.name}
                      </Text>
                      <Text variant="caption" tone="faint">
                        {peer.status === 'connected'
                          ? 'Connected'
                          : peer.status === 'invited'
                            ? 'Invitation sent — accept it on that device'
                            : unavailable
                              ? 'Not available'
                              : 'Tap Connect to pair directly'}
                      </Text>
                    </View>
                    <Button
                      label={peer.status === 'connected' ? 'Connected' : 'Connect'}
                      variant="secondary"
                      disabled={unavailable || peer.status === 'connected'}
                      loading={inviting === peer.address}
                      onPress={() => {
                        void (async () => {
                          setInviting(peer.address);
                          const result = await invite(peer.address);
                          setInviting(null);
                          if (!result.ok && result.message) {
                            toast(result.message, 'error');
                          } else {
                            toast(
                              `Invitation sent to ${peer.name} — accept it on that device`,
                            );
                          }
                        })();
                      }}
                    />
                  </View>
                );
              })
            )}
          </View>

          <Text variant="caption" tone="faint" style={{ marginTop: theme.spacing.md }}>
            Your normal Wi-Fi keeps working, and no internet is needed either
            way.
          </Text>
        </View>
      ) : null}
    </Card>
  );
}
