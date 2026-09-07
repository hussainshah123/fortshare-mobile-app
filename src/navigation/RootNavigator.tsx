import React from 'react';
import { View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useTheme } from '../theme';
import { Button, Icon, Text, type IconName } from '../components/ui';
import {
  ActiveTransferScreen,
  DeviceDetailScreen,
  DeviceProfileScreen,
  DevicesScreen,
  FilePickerScreen,
  FilesScreen,
  HomeScreen,
  QrScanScreen,
  QrShowScreen,
  SearchScreen,
  SendReviewScreen,
  SettingsScreen,
  TransferDetailScreen,
  TransfersScreen,
} from '../screens';
import { activeTransfers, useDeviceStore, useTransferStore } from '../store';
import type { RootStackParamList, TabParamList } from './types';

const Tabs = createBottomTabNavigator<TabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Hoisted out of the navigator so it is a stable render callback rather than a
 * component defined during render — otherwise React remounts each tab icon on
 * every navigation state change.
 */
function renderTabIcon(
  name: IconName,
  { color, focused }: { color: string; focused: boolean },
): React.ReactNode {
  return <Icon name={name} size={23} color={color} filled={focused} />;
}

const TAB_ICONS: Record<keyof TabParamList, IconName> = {
  Home: 'home',
  Devices: 'devices',
  Transfers: 'transfers',
  Files: 'files',
  Settings: 'settings',
};

/** Bottom tabs (§31), with live badges for nearby devices and active transfers. */
function TabNavigator() {
  const theme = useTheme();
  const nearby = useDeviceStore((state) => state.peers.size);
  const running = useTransferStore((state) => activeTransfers(state).length);

  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textFaint,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          borderTopWidth: 1,
          height: 62,
          paddingTop: 6,
          paddingBottom: 8,
        },
        tabBarLabelStyle: {
          ...theme.typography.caption,
          fontSize: 11,
        },
        tabBarIcon: (props) => renderTabIcon(TAB_ICONS[route.name], props),
      })}
    >
      <Tabs.Screen name="Home" component={HomeScreen} />
      <Tabs.Screen
        name="Devices"
        component={DevicesScreen}
        options={{
          tabBarBadge: nearby > 0 ? nearby : undefined,
          tabBarBadgeStyle: {
            backgroundColor: theme.colors.success,
            color: theme.colors.textInverse,
            fontSize: 10,
          },
        }}
      />
      <Tabs.Screen
        name="Transfers"
        component={TransfersScreen}
        options={{
          tabBarBadge: running > 0 ? running : undefined,
          tabBarBadgeStyle: {
            backgroundColor: theme.colors.accent,
            color: theme.colors.textInverse,
            fontSize: 10,
          },
        }}
      />
      <Tabs.Screen name="Files" component={FilesScreen} />
      <Tabs.Screen name="Settings" component={SettingsScreen} />
    </Tabs.Navigator>
  );
}

export function RootNavigator() {
  const theme = useTheme();

  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
        // Sheets for the flows the user is stepping *through*, pushes for
        // things they are navigating *to*.
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="Tabs" component={TabNavigator} />
      <Stack.Screen name="DeviceDetail" component={DeviceDetailScreen} />
      <Stack.Screen name="TransferDetail" component={TransferDetailScreen} />
      <Stack.Screen name="ActiveTransfer" component={ActiveTransferScreen} />
      <Stack.Screen name="FilePicker" component={FilePickerScreen} />
      <Stack.Screen name="SendReview" component={SendReviewScreen} />
      <Stack.Screen
        name="QrShow"
        component={QrShowScreen}
        options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
      />
      <Stack.Screen
        name="QrScan"
        component={QrScanScreen}
        options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
      />
      <Stack.Screen
        name="Search"
        component={SearchScreen}
        options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
      />
      <Stack.Screen name="DeviceProfile" component={DeviceProfileScreen} />
    </Stack.Navigator>
  );
}

/** Shown while the database opens and the identity loads, and on boot failure. */
export function BootSplash({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.lg,
        backgroundColor: theme.colors.background,
      }}
    >
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: theme.radius.xxl,
          backgroundColor: theme.colors.accentSoft,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="send" size={32} color={theme.colors.accent} />
      </View>
      <Text variant="title">FortShare</Text>
      <Text variant="body" tone="muted" center style={{ maxWidth: 300 }}>
        {message}
      </Text>
      {actionLabel && onAction ? (
        <Button label={actionLabel} onPress={onAction} variant="secondary" />
      ) : null}
    </View>
  );
}
