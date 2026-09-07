import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, SectionList, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import {
  Button,
  Card,
  EmptyState,
  Screen,
  SearchField,
  SegmentedControl,
  SkeletonList,
  Text,
} from '../components/ui';
import { FileRow } from '../components/file/FileRow';
import { FortShareFs } from '../native';
import type { DirEntry } from '../native/FortShareFs';
import { useTransferStore, useUiStore, type ReceivedFile } from '../store';
import type { RootStackParamList } from '../navigation/types';
import { formatBytes, groupByDate } from '../utils/format';
import { guessMimeType } from '../utils/files';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Tab = 'received' | 'local';

/**
 * Files (§25, §31): what other devices sent us, and what is on disk in the
 * FortShare folder.
 *
 * The two tabs are deliberately different views of nearly the same thing:
 * "Received" is the *record* (who sent it, when, verified or not), "On this
 * device" is the *folder* — which still lists files whose history rows the
 * user has since deleted.
 */
export function FilesScreen() {
  const theme = useTheme();
  const navigation = useNavigation<Nav>();
  const toast = useUiStore((state) => state.toast);

  const [tab, setTab] = useState<Tab>('received');
  const [query, setQuery] = useState('');
  const [local, setLocal] = useState<DirEntry[]>([]);
  const [loadingLocal, setLoadingLocal] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const received = useTransferStore((state) => state.received);

  const loadLocal = useCallback(async () => {
    setLoadingLocal(true);
    try {
      const dir = await FortShareFs.receivedDir();
      const entries = await FortShareFs.listDir(dir);
      // Hide in-flight partials: a half-received file is not a file yet.
      setLocal(entries.filter((entry) => !entry.name.endsWith('.fortshare-part')));
    } catch {
      setLocal([]);
    } finally {
      setLoadingLocal(false);
    }
  }, []);

  useEffect(() => {
    void useTransferStore.getState().refreshReceived();
  }, []);

  useEffect(() => {
    if (tab === 'local') void loadLocal();
  }, [tab, loadLocal]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([useTransferStore.getState().refreshReceived(), loadLocal()]);
    setRefreshing(false);
  }, [loadLocal]);

  const open = useCallback(
    async (path: string | null, mimeType: string) => {
      if (!path) return;
      try {
        await FortShareFs.openFile(path, mimeType);
      } catch {
        toast('No app on this device can open that file', 'error');
      }
    },
    [toast],
  );

  const share = useCallback(
    async (path: string | null, mimeType: string) => {
      if (!path) return;
      await FortShareFs.shareFile(path, mimeType).catch(() =>
        toast('Could not share that file', 'error'),
      );
    },
    [toast],
  );

  const confirmDelete = useCallback(
    (name: string, path: string | null) => {
      if (!path) return;
      Alert.alert(`Delete ${name}?`, 'This removes the file from this device.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void FortShareFs.unlink(path)
              .then(() => refresh())
              .then(() => toast(`${name} deleted`))
              .catch(() => toast('Could not delete that file', 'error'));
          },
        },
      ]);
    },
    [refresh, toast],
  );

  const filteredReceived = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return received;
    return received.filter(
      (file) =>
        file.name.toLowerCase().includes(term) ||
        file.deviceName.toLowerCase().includes(term),
    );
  }, [received, query]);

  const filteredLocal = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return local;
    return local.filter((entry) => entry.name.toLowerCase().includes(term));
  }, [local, query]);

  const sections = useMemo(
    () =>
      tab === 'received'
        ? groupByDate<ReceivedFile>(filteredReceived, (file) => file.receivedAt)
        : groupByDate<DirEntry>(filteredLocal, (entry) => entry.mtime),
    [tab, filteredReceived, filteredLocal],
  );

  const totalBytes = useMemo(
    () =>
      tab === 'received'
        ? filteredReceived.reduce((sum, file) => sum + file.size, 0)
        : filteredLocal.reduce((sum, entry) => sum + entry.size, 0),
    [tab, filteredReceived, filteredLocal],
  );

  return (
    <Screen
      title="Files"
      subtitle={
        totalBytes > 0 ? `${formatBytes(totalBytes)} on this device` : undefined
      }
    >
      <View style={{ gap: theme.spacing.md }}>
        <SegmentedControl<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'received', label: 'Received', count: received.length },
            { value: 'local', label: 'On this device', count: local.length },
          ]}
        />
        <SearchField value={query} onChange={setQuery} placeholder="Search files" />
      </View>

      <SectionList
        sections={
          sections as { title: string; data: (ReceivedFile | DirEntry)[] }[]
        }
        keyExtractor={(item, index) =>
          'id' in item ? item.id : `${item.path}-${index}`
        }
        stickySectionHeadersEnabled={false}
        showsVerticalScrollIndicator={false}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        contentContainerStyle={{
          paddingTop: theme.spacing.lg,
          paddingBottom: theme.spacing.huge,
        }}
        renderSectionHeader={({ section }) => (
          <Text
            variant="label"
            tone="faint"
            style={{ marginTop: theme.spacing.lg, marginBottom: theme.spacing.sm }}
          >
            {section.title.toUpperCase()}
          </Text>
        )}
        renderItem={({ item }) => {
          const isRecord = 'id' in item;
          const path = isRecord ? item.destPath : item.path;
          const mimeType = isRecord
            ? item.mimeType
            : item.mimeType || guessMimeType(item.name);

          return (
            <FileRow
              name={item.name}
              size={item.size}
              mimeType={mimeType}
              thumbnailUri={path ? `file://${path}` : undefined}
              subtitle={
                isRecord
                  ? `From ${item.deviceName}${item.verified ? ' · Verified' : ''}`
                  : undefined
              }
              onPress={() => void open(path, mimeType)}
              onLongPress={() =>
                Alert.alert(item.name, formatBytes(item.size), [
                  { text: 'Open', onPress: () => void open(path, mimeType) },
                  { text: 'Share', onPress: () => void share(path, mimeType) },
                  {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () => confirmDelete(item.name, path),
                  },
                  { text: 'Cancel', style: 'cancel' },
                ])
              }
            />
          );
        }}
        ListEmptyComponent={
          loadingLocal ? (
            <SkeletonList count={3} />
          ) : (
            <EmptyState
              icon="files"
              title={query ? 'No matches' : 'No files yet'}
              message={
                query
                  ? 'Try a different search.'
                  : 'Files other devices send you land here, grouped by when they arrived.'
              }
              actionLabel={query ? undefined : 'Find devices'}
              onAction={
                query
                  ? undefined
                  : () => navigation.navigate('Tabs', { screen: 'Devices' })
              }
            />
          )
        }
        ListFooterComponent={
          sections.length > 0 ? (
            <Card style={{ marginTop: theme.spacing.lg }}>
              <Text variant="caption" tone="muted">
                Long-press a file to open, share or delete it. Received files
                are stored only on this device.
              </Text>
            </Card>
          ) : null
        }
      />

      {tab === 'local' && local.length > 0 ? (
        <View style={{ position: 'absolute', right: theme.spacing.xl, bottom: theme.spacing.xl }}>
          <Button label="Refresh" icon="refresh" variant="secondary" onPress={() => void loadLocal()} />
        </View>
      ) : null}
    </Screen>
  );
}
