import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { pick, types } from '@react-native-documents/picker';
import { CameraRoll } from '@react-native-camera-roll/camera-roll';
import { FortShareFs } from '../native';
import type { AudioTrack, InstalledApp } from '../native/FortShareFs';
import { useTheme } from '../theme';
import {
  Button,
  Card,
  EmptyState,
  Screen,
  SearchField,
  SegmentedControl,
  Text,
} from '../components/ui';
import { CategoryTile, FileRow } from '../components/file/FileRow';
import { AppRow, TrackRow } from '../components/file/AppRow';
import { findDevice, useDeviceStore, useUiStore } from '../store';
import type { RootStackParamList } from '../navigation/types';
import type { FileCategory, SelectedFile } from '../models/transfer';
import { CATEGORY_LABELS, categoryOf, guessMimeType } from '../utils/files';
import { formatBytes } from '../utils/format';
import { requestMediaAccess } from '../services/permissions';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Route = RouteProp<RootStackParamList, 'FilePicker'>;
type Sort = 'recent' | 'name' | 'size';

/**
 * A row in any of the three browsable lists.
 *
 * Photos, apps and tracks are presented very differently but select
 * identically, so they share one row type and one selection map. `file` is the
 * common denominator every kind reduces to before being sent.
 */
type PickerRow =
  | { key: string; file: SelectedFile; app?: undefined; track?: undefined }
  | { key: string; file: SelectedFile; app: InstalledApp; track?: undefined }
  | { key: string; file: SelectedFile; app?: undefined; track: AudioTrack };

const APK_MIME = 'application/vnd.android.package-archive';

/**
 * The picker (§16).
 *
 * Two ways in, because the platforms differ in what they will hand over
 * without a broad permission:
 *
 *   - Photos/Videos come from the media library, which gives us thumbnails and
 *     sizes for a grid.
 *   - Everything else goes through the system document picker, which is the
 *     only route to arbitrary files on iOS and the only one on Android that
 *     avoids asking for blanket storage access (§37).
 */
export function FilePickerScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Route>();
  const toast = useUiStore((state) => state.toast);

  const device = useDeviceStore((state) => findDevice(state, params.deviceId));

  const [category, setCategory] = useState<FileCategory | null>(null);
  const [media, setMedia] = useState<SelectedFile[]>([]);
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [tracks, setTracks] = useState<AudioTrack[]>([]);
  const [selected, setSelected] = useState<Map<string, SelectedFile>>(new Map());
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [loading, setLoading] = useState(false);

  const loadMedia = useCallback(
    async (target: 'photos' | 'videos') => {
      setLoading(true);
      try {
        const granted = await requestMediaAccess(target);
        if (!granted) {
          toast('FortShare needs access to your media to pick files', 'error');
          setCategory(null);
          return;
        }

        const page = await CameraRoll.getPhotos({
          first: 200,
          assetType: target === 'photos' ? 'Photos' : 'Videos',
          include: ['filename', 'fileSize', 'imageSize', 'playableDuration'],
        });

        setMedia(
          page.edges.map((edge, index) => {
            const name =
              edge.node.image.filename ??
              `${target === 'photos' ? 'IMG' : 'VID'}_${index + 1}`;
            return {
              uri: edge.node.image.uri,
              name,
              size: edge.node.image.fileSize ?? 0,
              mimeType: edge.node.type || guessMimeType(name),
              thumbnailUri: edge.node.image.uri,
            };
          }),
        );
      } catch (error) {
        toast(
          error instanceof Error ? error.message : 'Could not read your media',
          'error',
        );
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  /**
   * Installed apps.
   *
   * Android only: an installed APK lives under /data/app, which the document
   * picker cannot browse, so this native listing is the only route. iOS has no
   * app-enumeration API at all, and the UI says so rather than showing an
   * empty list.
   */
  const loadApps = useCallback(async () => {
    setLoading(true);
    try {
      setApps(await FortShareFs.listInstalledApps());
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'Could not read installed apps',
        'error',
      );
    } finally {
      setLoading(false);
    }
  }, [toast]);

  /**
   * The music library, browsable by title and artist.
   *
   * On iOS this comes back empty (Apple Music tracks are DRM-protected and
   * cannot be exported), so we fall straight through to the document picker
   * for local audio files.
   */
  const loadTracks = useCallback(async () => {
    setLoading(true);
    try {
      const granted = await requestMediaAccess('music');
      if (!granted) {
        toast('FortShare needs access to your music to pick tracks', 'error');
        setCategory(null);
        return;
      }
      const found = await FortShareFs.listAudio();
      setTracks(found);
      if (found.length === 0 && Platform.OS === 'ios') {
        setCategory(null);
        await pickDocuments('music');
      }
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'Could not read your music',
        'error',
      );
    } finally {
      setLoading(false);
    }
    // pickDocuments is declared below; it is stable and only used on the
    // iOS fallback path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  useEffect(() => {
    if (category === 'photos' || category === 'videos') void loadMedia(category);
    if (category === 'apk') void loadApps();
    if (category === 'music') void loadTracks();
  }, [category, loadMedia, loadApps, loadTracks]);

  /** Hand off to the system document picker for non-media categories. */
  const pickDocuments = useCallback(
    async (target: FileCategory) => {
      try {
        const results = await pick({
          allowMultiSelection: true,
          type: documentTypesFor(target),
        });

        const picked: SelectedFile[] = results
          .filter((result) => !result.error)
          .map((result) => {
            const name = result.name ?? 'file';
            return {
              uri: result.uri,
              name,
              size: result.size ?? 0,
              mimeType: result.type ?? guessMimeType(name),
            };
          });

        if (picked.length === 0) return;

        setSelected((current) => {
          const next = new Map(current);
          for (const file of picked) next.set(file.uri, file);
          return next;
        });
        toast(`${picked.length} added`, 'success');
      } catch (error) {
        // A cancelled picker is not an error worth surfacing.
        const message = error instanceof Error ? error.message : '';
        if (/cancel/i.test(message)) return;
        if (message) toast(message, 'error');
      }
    },
    [toast],
  );

  const toggle = useCallback((file: SelectedFile) => {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(file.uri)) next.delete(file.uri);
      else next.set(file.uri, file);
      return next;
    });
  }, []);

  const visible = useMemo<PickerRow[]>(() => {
    const rows: PickerRow[] = (() => {
      if (category === 'apk') {
        return apps.map((app) => ({
          key: app.packageName,
          app,
          file: {
            uri: app.path,
            name: app.name,
            size: app.size,
            mimeType: APK_MIME,
          },
        }));
      }
      if (category === 'music') {
        return tracks.map((track) => ({
          key: track.path,
          track,
          file: {
            uri: track.path,
            name: track.name,
            size: track.size,
            mimeType: track.mimeType,
          },
        }));
      }
      return media.map((file) => ({ key: file.uri, file }));
    })();

    const term = query.trim().toLowerCase();
    const filtered = term
      ? rows.filter((row) => {
          // Search what the user can actually see: a track by title or
          // artist, an app by its label, a photo by filename.
          const haystack = [
            row.file.name,
            row.track?.title,
            row.track?.artist,
            row.track?.album,
            row.app?.packageName,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return haystack.includes(term);
        })
      : rows;

    const sorted = [...filtered];
    if (sort === 'name') {
      sorted.sort((a, b) =>
        (a.track?.title ?? a.file.name).localeCompare(
          b.track?.title ?? b.file.name,
        ),
      );
    }
    if (sort === 'size') sorted.sort((a, b) => b.file.size - a.file.size);
    return sorted;
  }, [category, media, apps, tracks, query, sort]);

  const chosen = useMemo(() => [...selected.values()], [selected]);
  const totalBytes = chosen.reduce((sum, file) => sum + file.size, 0);
  const allVisibleSelected =
    visible.length > 0 && visible.every((row) => selected.has(row.file.uri));

  const proceed = useCallback(() => {
    if (chosen.length === 0) return;
    navigation.navigate('SendReview', {
      deviceId: params.deviceId,
      files: chosen,
    });
  }, [chosen, navigation, params.deviceId]);

  // ---------------------------------------------------------------- category grid

  if (!category) {
    const categories: FileCategory[] = [
      'photos',
      'videos',
      'music',
      'documents',
      'apk',
      'archives',
      'other',
      'folders',
    ];

    return (
      <Screen
        title="Send files"
        subtitle={device ? `To ${device.name}` : undefined}
        scroll
      >
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: theme.spacing.md,
            marginBottom: theme.spacing.xl,
          }}
        >
          {categories.map((item) => (
            <CategoryTile
              key={item}
              category={item}
              label={CATEGORY_LABELS[item]}
              onPress={() => {
                // Photos, videos, music and apps get a proper browsable list;
                // everything else goes to the system document picker, which
                // needs no permission and can reach any file.
                if (
                  item === 'photos' ||
                  item === 'videos' ||
                  item === 'music' ||
                  item === 'apk'
                ) {
                  setCategory(item);
                } else {
                  void pickDocuments(item);
                }
              }}
            />
          ))}
        </View>

        {chosen.length > 0 ? (
          <SelectionBar
            count={chosen.length}
            bytes={totalBytes}
            deviceName={device?.name}
            onClear={() => setSelected(new Map())}
            onSend={proceed}
          />
        ) : (
          <Card>
            <Text variant="body" tone="muted">
              Pick a category to choose what to send. You can mix photos,
              videos and documents in one transfer.
            </Text>
          </Card>
        )}
      </Screen>
    );
  }

  // ------------------------------------------------------------------ media list

  return (
    <Screen
      title={CATEGORY_LABELS[category]}
      subtitle={device ? `To ${device.name}` : undefined}
      action={
        <Button label="Back" icon="chevron-left" variant="ghost" onPress={() => setCategory(null)} />
      }
    >
      <View style={{ gap: theme.spacing.md }}>
        <SearchField value={query} onChange={setQuery} placeholder="Search files" />
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
          <View style={{ flex: 1 }}>
            <SegmentedControl<Sort>
              value={sort}
              onChange={setSort}
              options={[
                { value: 'recent', label: 'Recent' },
                { value: 'name', label: 'Name' },
                { value: 'size', label: 'Size' },
              ]}
            />
          </View>
          <Button
            label={allVisibleSelected ? 'None' : 'All'}
            variant="secondary"
            onPress={() =>
              setSelected((current) => {
                const next = new Map(current);
                if (allVisibleSelected) {
                  for (const row of visible) next.delete(row.file.uri);
                } else {
                  for (const row of visible) next.set(row.file.uri, row.file);
                }
                return next;
              })
            }
          />
        </View>
      </View>

      <FlatList
        data={visible}
        keyExtractor={(item) => item.key}
        contentContainerStyle={{
          paddingTop: theme.spacing.lg,
          // Enough room to scroll the last row clear of the floating bar,
          // including the home indicator or navigation bar below it.
          paddingBottom:
            chosen.length > 0
              ? 150 + insets.bottom
              : theme.spacing.huge + insets.bottom,
        }}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => {
          const isSelected = selected.has(item.file.uri);
          const onPress = () => toggle(item.file);

          // An app is recognised by its icon, a track by title and artist, a
          // photo by its thumbnail — so each kind gets the row that shows the
          // thing the user is actually looking for.
          if (item.app) {
            return (
              <AppRow
                name={item.app.name}
                packageName={item.app.packageName}
                versionName={item.app.versionName}
                size={item.app.size}
                iconPath={item.app.iconPath}
                selected={isSelected}
                onPress={onPress}
              />
            );
          }
          if (item.track) {
            return (
              <TrackRow
                title={item.track.title}
                artist={item.track.artist}
                album={item.track.album}
                size={item.track.size}
                durationMs={item.track.durationMs}
                selected={isSelected}
                onPress={onPress}
              />
            );
          }
          return (
            <FileRow
              name={item.file.name}
              size={item.file.size}
              mimeType={item.file.mimeType}
              thumbnailUri={item.file.thumbnailUri}
              selected={isSelected}
              onPress={onPress}
            />
          );
        }}
        ListEmptyComponent={
          loading ? (
            <View style={{ paddingVertical: theme.spacing.huge }}>
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          ) : query ? (
            <EmptyState
              icon="search"
              title="No matches"
              message="Try a different search."
            />
          ) : category === 'apk' && Platform.OS === 'ios' ? (
            <EmptyState
              icon="apk"
              title="Not possible on iOS"
              message="iOS does not let an app read or list other installed apps, so FortShare cannot share them. You can still receive apps from an Android device — they will arrive in your Files."
              actionLabel="Browse files instead"
              onAction={() => void pickDocuments('other')}
            />
          ) : (
            <EmptyState
              icon={
                category === 'videos'
                  ? 'video'
                  : category === 'music'
                    ? 'music'
                    : category === 'apk'
                      ? 'apk'
                      : 'photo'
              }
              title={`No ${CATEGORY_LABELS[category].toLowerCase()} found`}
              message="Nothing here yet. You can still pick any file from your device's file browser."
              actionLabel="Browse all files"
              onAction={() => void pickDocuments('other')}
            />
          )
        }
      />

      {chosen.length > 0 ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            // Clears the home indicator / software navigation bar, which was
            // cutting the Continue button in half on gesture-nav devices.
            bottom: insets.bottom + theme.spacing.md,
          }}
        >
          <SelectionBar
            count={chosen.length}
            bytes={totalBytes}
            deviceName={device?.name}
            onClear={() => setSelected(new Map())}
            onSend={proceed}
          />
        </View>
      ) : null}
    </Screen>
  );
}

/** "3 files selected · 428 MB · Destination: Samsung S25 · [Send Files]" (§16). */
function SelectionBar({
  count,
  bytes,
  deviceName,
  onClear,
  onSend,
}: {
  count: number;
  bytes: number;
  deviceName?: string;
  onClear: () => void;
  onSend: () => void;
}) {
  const theme = useTheme();
  return (
    <Card elevation={3}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          marginBottom: theme.spacing.md,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text variant="subheading">
            {count} {count === 1 ? 'file' : 'files'} selected
          </Text>
          <Text variant="caption" tone="muted">
            Total {formatBytes(bytes)}
            {deviceName ? ` · to ${deviceName}` : ''}
          </Text>
        </View>
        <Button label="Clear" variant="ghost" onPress={onClear} />
      </View>
      <Button label="Continue" icon="send" size="lg" block onPress={onSend} />
    </Card>
  );
}

/** Maps a picker category to the document picker's type identifiers. */
function documentTypesFor(category: FileCategory): string[] | undefined {
  switch (category) {
    case 'music':
      return [types.audio];
    case 'documents':
      // `types.csv` is an array on Android and a string on iOS, so the list is
      // flattened rather than assuming either shape.
      return [
        types.pdf,
        types.doc,
        types.docx,
        types.xls,
        types.xlsx,
        types.ppt,
        types.pptx,
        types.plainText,
      ].flatMap((entry) => (Array.isArray(entry) ? [...entry] : [entry]));
    case 'archives':
      return [types.zip];
    case 'apk':
      // Android package files have no cross-platform UTI, so both platforms
      // fall back to "any file" rather than an identifier iOS would reject.
      return undefined;
    case 'folders':
    case 'other':
    default:
      return undefined;
  }
}

/** Re-exported for use by the category grid. */
export { categoryOf };
