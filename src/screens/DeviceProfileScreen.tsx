import React, { useCallback, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { Avatar, Button, Card, Icon, Screen, Section, Text } from '../components/ui';
import { useAppStore, useUiStore } from '../store';
import { AVATAR_CHOICES } from '../services/identity';
import { republishIdentity } from '../services/bootstrap';
import { formatFingerprint } from '../services/crypto';
import { formatDate } from '../utils/format';

/**
 * Editing this device's display name and avatar (§5).
 *
 * The screen exists partly to make the guarantee visible: changing what other
 * people see does not change who this device *is*. The identity block below
 * the editor shows the unchanging deviceId and security code.
 */
export function DeviceProfileScreen() {
  const theme = useTheme();
  const navigation = useNavigation();
  const toast = useUiStore((state) => state.toast);

  const identity = useAppStore((state) => state.identity);
  const rename = useAppStore((state) => state.rename);
  const changeAvatar = useAppStore((state) => state.changeAvatar);

  const [name, setName] = useState(identity?.deviceName ?? '');
  const [avatar, setAvatar] = useState(identity?.avatar ?? AVATAR_CHOICES[0]!);
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast('Give this device a name', 'error');
      return;
    }
    setSaving(true);
    rename(trimmed);
    changeAvatar(avatar);
    // Re-advertise so nearby devices see the new name at once — under the
    // same deviceId, so nobody treats it as a different device.
    await republishIdentity();
    setSaving(false);
    toast('Device updated', 'success');
    navigation.goBack();
  }, [name, avatar, rename, changeAvatar, toast, navigation]);

  return (
    <Screen title="My device" scroll>
      <Card elevation={2} style={{ alignItems: 'center', marginBottom: theme.spacing.xl }}>
        <Avatar avatar={avatar} name={name || 'Device'} size={76} highlight />
        <Text variant="caption" tone="faint" style={{ marginTop: theme.spacing.md }}>
          This is how you appear to nearby devices
        </Text>
      </Card>

      <Section title="Name">
        <Card>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Hussain's iPhone"
            placeholderTextColor={theme.colors.textFaint}
            maxLength={40}
            accessibilityLabel="Device name"
            style={{
              ...theme.typography.subheading,
              color: theme.colors.text,
              paddingVertical: theme.spacing.sm,
            }}
          />
          <Text variant="caption" tone="faint" style={{ marginTop: theme.spacing.xs }}>
            {name.trim().length}/40
          </Text>
        </Card>
      </Section>

      <Section title="Avatar">
        <Card>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
            {AVATAR_CHOICES.map((choice) => {
              const selected = choice === avatar;
              return (
                <Pressable
                  key={choice}
                  onPress={() => setAvatar(choice)}
                  accessibilityRole="button"
                  accessibilityLabel={`Avatar ${choice}`}
                  accessibilityState={{ selected }}
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: theme.radius.md,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: selected ? 2 : 1,
                    borderColor: selected ? theme.colors.accent : theme.colors.border,
                    backgroundColor: selected
                      ? theme.colors.accentSoft
                      : theme.colors.surfaceAlt,
                  }}
                >
                  <Text style={{ fontSize: 24 }}>{choice}</Text>
                </Pressable>
              );
            })}
          </View>
        </Card>
      </Section>

      <Section title="Identity">
        <Card>
          <IdentityRow
            label="Device ID"
            value={identity?.deviceId ?? '—'}
            mono
          />
          <IdentityRow
            label="Security code"
            value={identity ? formatFingerprint(identity.fingerprint) : '—'}
            mono
          />
          <IdentityRow
            label="Created"
            value={identity ? formatDate(identity.createdAt) : '—'}
          />
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
              This identity was generated on this device and never leaves it.
              It stays the same when you rename the device, change Wi-Fi, or
              move to a different network — which is how devices you have
              already paired with keep recognising you.
            </Text>
          </View>
        </Card>
      </Section>

      <Button
        label="Save"
        size="lg"
        block
        loading={saving}
        onPress={() => void save()}
      />
    </Screen>
  );
}

function IdentityRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={{ marginBottom: theme.spacing.md }}>
      <Text variant="caption" tone="faint">
        {label}
      </Text>
      <Text variant={mono ? 'mono' : 'body'} style={{ marginTop: 2 }}>
        {value}
      </Text>
    </View>
  );
}
