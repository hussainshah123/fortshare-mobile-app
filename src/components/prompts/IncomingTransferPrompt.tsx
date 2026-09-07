import React from 'react';
import { ScrollView, View } from 'react-native';
import { useTheme } from '../../theme';
import { Avatar, Button, Sheet, Text } from '../ui';
import { FileRow } from '../file/FileRow';
import { useUiStore } from '../../store';
import { formatBytes } from '../../utils/format';

/**
 * "Samsung S25 wants to send 7 files" (§15).
 *
 * No byte is accepted before this is answered. The file list is shown in full
 * so the decision is informed — an approval prompt that only says "7 files"
 * is not really consent.
 */
export function IncomingTransferPrompt() {
  const theme = useTheme();
  const prompt = useUiStore((state) => state.transferPrompt);
  const answer = useUiStore((state) => state.answerTransferApproval);

  if (!prompt) return null;
  const { session, offer } = prompt;
  const count = offer.files.length;

  return (
    <Sheet visible mandatory title="Incoming files">
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          marginBottom: theme.spacing.lg,
        }}
      >
        <Avatar
          name={session.peer.deviceName}
          deviceType={session.peer.deviceType}
          size={48}
        />
        <View style={{ flex: 1 }}>
          <Text variant="subheading">{session.peer.deviceName}</Text>
          <Text variant="body" tone="muted">
            wants to send {count} {count === 1 ? 'file' : 'files'} ·{' '}
            {formatBytes(offer.totalBytes)}
          </Text>
        </View>
      </View>

      <ScrollView
        style={{ maxHeight: 240 }}
        showsVerticalScrollIndicator={false}
      >
        {offer.files.map((file) => (
          <FileRow
            key={file.fileId}
            name={file.name}
            size={file.size}
            mimeType={file.mimeType}
          />
        ))}
      </ScrollView>

      <View
        style={{ flexDirection: 'row', gap: theme.spacing.sm, marginTop: theme.spacing.lg }}
      >
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
