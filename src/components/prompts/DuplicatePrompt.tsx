import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme';
import { Button, Sheet, Text } from '../ui';
import { useUiStore } from '../../store';
import { formatBytes } from '../../utils/format';

/**
 * "Vacation.mp4 already exists" (§26).
 *
 * Asked *before* any byte of that file is written, so whichever option the
 * user picks, nothing has been overwritten in the meantime.
 */
export function DuplicatePrompt() {
  const theme = useTheme();
  const prompt = useUiStore((state) => state.duplicatePrompt);
  const answer = useUiStore((state) => state.answerDuplicateResolution);

  if (!prompt) return null;
  const suggested = keepBothName(prompt.fileName);

  return (
    <Sheet visible mandatory title="File already exists">
      <Text variant="body" tone="muted">
        <Text variant="bodyMedium">{prompt.fileName}</Text> is already in your
        received files. Incoming file is {formatBytes(prompt.size)}.
      </Text>

      <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.xl }}>
        <Button
          label="Keep both"
          onPress={() => answer('keep-both')}
          block
          accessibilityHint={`Saves the new file as ${suggested}`}
        />
        <Text variant="caption" tone="faint" center>
          Saves as {suggested}
        </Text>

        <Button
          label="Replace"
          variant="secondary"
          onPress={() => answer('replace')}
          block
          style={{ marginTop: theme.spacing.sm }}
        />
        <Button
          label="Skip this file"
          variant="ghost"
          onPress={() => answer('skip')}
          block
        />
      </View>
    </Sheet>
  );
}

/** Mirrors the native `uniquePath` naming so the preview is accurate. */
function keepBothName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name} (1)`;
  return `${name.slice(0, dot)} (1)${name.slice(dot)}`;
}
