import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import {
  Avatar,
  Button,
  Card,
  Icon,
  ProgressBar,
  Screen,
  Section,
  Text,
} from '../components/ui';
import { FileRow } from '../components/file/FileRow';
import { findDevice, useDeviceStore, useTransferStore } from '../store';
import type { RootStackParamList } from '../navigation/types';
import { formatBytes, percentOf } from '../utils/format';
import { useSendFlow } from '../hooks/useSendFlow';
import { requestNotificationAccess } from '../services/permissions';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Route = RouteProp<RootStackParamList, 'SendReview'>;

/**
 * The confirmation step (§16).
 *
 *   3 files selected · Total 428 MB · Destination Samsung S25 · [Send Files]
 *
 * The "Preparing" state is honest about what is happening: each file is
 * SHA-256'd before the offer goes out, which for a few gigabytes takes real
 * time and would otherwise look like a hang.
 */
export function SendReviewScreen() {
  const theme = useTheme();
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const { send } = useSendFlow();

  const device = useDeviceStore((state) => findDevice(state, params.deviceId));
  const preparing = useTransferStore((state) => state.preparing);
  const [sending, setSending] = useState(false);

  const files = params.files;
  const totalBytes = useMemo(
    () => files.reduce((sum, file) => sum + file.size, 0),
    [files],
  );

  const start = useCallback(async () => {
    if (!device) return;
    setSending(true);
    // Asked here, not at launch: the notification is what keeps the transfer
    // alive in the background, so this is the moment it becomes relevant.
    void requestNotificationAccess();

    const transferId = await send(device.deviceId, device.name, files);
    setSending(false);
    if (!transferId) return;

    navigation.navigate('ActiveTransfer', { transferId });
  }, [device, files, send, navigation]);

  return (
    <Screen title="Review" subtitle={device ? `Sending to ${device.name}` : undefined}>
      <Card elevation={2} style={{ marginBottom: theme.spacing.xl }}>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}
        >
          <Avatar
            avatar={device?.avatar}
            name={device?.name ?? 'Device'}
            deviceType={device?.deviceType}
            size={48}
          />
          <View style={{ flex: 1 }}>
            <Text variant="caption" tone="faint">
              Destination
            </Text>
            <Text variant="heading" numberOfLines={1}>
              {device?.name ?? 'Device'}
            </Text>
          </View>
          <Icon name="send" size={20} color={theme.colors.accent} />
        </View>

        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            marginTop: theme.spacing.lg,
            paddingTop: theme.spacing.md,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
          }}
        >
          <View>
            <Text variant="caption" tone="faint">
              Files
            </Text>
            <Text variant="heading">{files.length}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text variant="caption" tone="faint">
              Total
            </Text>
            <Text variant="heading">{formatBytes(totalBytes)}</Text>
          </View>
        </View>
      </Card>

      {preparing ? (
        <Card style={{ marginBottom: theme.spacing.xl }}>
          <Text variant="bodyMedium">Preparing files…</Text>
          <Text variant="caption" tone="muted" style={{ marginTop: 2 }}>
            Checksumming {preparing.done + 1} of {preparing.total} so the other
            device can verify what it receives.
          </Text>
          <View style={{ marginTop: theme.spacing.md }}>
            <ProgressBar percent={percentOf(preparing.done, preparing.total)} />
          </View>
        </Card>
      ) : null}

      <Section title="Files">
        <ScrollView style={{ maxHeight: 300 }} showsVerticalScrollIndicator={false}>
          {files.map((file) => (
            <FileRow
              key={file.uri}
              name={file.name}
              size={file.size}
              mimeType={file.mimeType}
              thumbnailUri={file.thumbnailUri}
            />
          ))}
        </ScrollView>
      </Section>

      <View style={{ gap: theme.spacing.sm }}>
        <Button
          label="Send Files"
          icon="send"
          size="lg"
          block
          loading={sending || preparing !== null}
          onPress={() => void start()}
        />
        <Text variant="caption" tone="faint" center>
          Files go straight to {device?.name ?? 'the other device'} over your
          local network. Nothing is uploaded to the internet.
        </Text>
      </View>
    </Screen>
  );
}
