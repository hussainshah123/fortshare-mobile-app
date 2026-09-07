import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme';
import { Avatar, Button, Icon, Sheet, Text } from '../ui';
import { useUiStore } from '../../store';
import { formatFingerprint } from '../../services/crypto';

/**
 * "Samsung S25 wants to connect" (§15, §44).
 *
 * Shown only for a device whose key we have never pinned. The handshake is
 * blocked on the answer, so the sheet is mandatory: dismissing it by accident
 * would leave the other device waiting.
 *
 * The fingerprint is displayed because it is the only thing a user can check
 * out of band. A name is chosen by whoever set the device up and can say
 * anything; the fingerprint is derived from a key they would have to actually
 * possess.
 */
export function PairingPrompt() {
  const theme = useTheme();
  const prompt = useUiStore((state) => state.pairingPrompt);
  const answer = useUiStore((state) => state.answerPairing);

  if (!prompt) return null;
  const { peer } = prompt;

  return (
    <Sheet visible mandatory title="Connection request">
      <View style={{ alignItems: 'center', gap: theme.spacing.md }}>
        <Avatar name={peer.deviceName} deviceType={peer.deviceType} size={64} />
        <View style={{ alignItems: 'center' }}>
          <Text variant="title" center>
            {peer.deviceName}
          </Text>
          <Text variant="body" tone="muted" center style={{ marginTop: 2 }}>
            wants to connect to this device
          </Text>
        </View>
      </View>

      <View
        style={{
          marginTop: theme.spacing.xl,
          padding: theme.spacing.md,
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.surfaceAlt,
          gap: theme.spacing.sm,
        }}
      >
        <Detail label="Platform" value={peer.platform === 'ios' ? 'iOS' : 'Android'} />
        <Detail label="Security code" value={formatFingerprint(peer.fingerprint)} mono />
      </View>

      <View
        style={{
          flexDirection: 'row',
          gap: theme.spacing.sm,
          marginTop: theme.spacing.md,
          alignItems: 'flex-start',
        }}
      >
        <Icon name="shield" size={15} color={theme.colors.textFaint} />
        <Text variant="caption" tone="faint" style={{ flex: 1 }}>
          Accept only if you recognise this device. Check the security code
          matches the one it is showing. Once accepted, it can send you files
          without asking again.
        </Text>
      </View>

      <View style={{ flexDirection: 'row', gap: theme.spacing.sm, marginTop: theme.spacing.xl }}>
        <Button
          label="Reject"
          variant="secondary"
          onPress={() => answer(false)}
          style={{ flex: 1 }}
        />
        <Button label="Accept" onPress={() => answer(true)} style={{ flex: 1.3 }} />
      </View>
    </Sheet>
  );
}

function Detail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant={mono ? 'mono' : 'caption'}>{value}</Text>
    </View>
  );
}
