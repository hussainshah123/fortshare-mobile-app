import React, { useEffect, useRef } from 'react';
import { Animated, Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme';
import { Text } from './Text';

/** Scrim fill. StyleSheet.absoluteFillObject, spelled out to stay inline-safe. */
const ABSOLUTE_FILL = {
  position: 'absolute' as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};

interface Props {
  visible: boolean;
  onClose?: () => void;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  /** Blocks tap-outside and the hardware back button. Used for decisions the
   *  networking layer is actively blocked on, where dismissing would leave a
   *  peer hanging. */
  mandatory?: boolean;
}

/** The bottom sheet used for every prompt and picker in the app. */
export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  mandatory = false,
}: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(slide, {
      toValue: visible ? 1 : 0,
      duration: visible ? theme.duration.normal : theme.duration.fast,
      useNativeDriver: true,
    }).start();
  }, [visible, slide, theme.duration]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={mandatory ? undefined : onClose}
    >
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Animated.View
          style={{
            ...ABSOLUTE_FILL,
            backgroundColor: theme.colors.scrim,
            opacity: slide,
          }}
        >
          <Pressable
            style={{ flex: 1 }}
            onPress={mandatory ? undefined : onClose}
            accessibilityLabel={mandatory ? undefined : 'Dismiss'}
          />
        </Animated.View>

        <Animated.View
          style={{
            backgroundColor: theme.colors.surface,
            borderTopLeftRadius: theme.radius.xxl,
            borderTopRightRadius: theme.radius.xxl,
            paddingTop: theme.spacing.md,
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: insets.bottom + theme.spacing.xl,
            transform: [
              {
                translateY: slide.interpolate({
                  inputRange: [0, 1],
                  outputRange: [420, 0],
                }),
              },
            ],
          }}
        >
          {/* Grabber, omitted when the sheet cannot be dismissed. */}
          {mandatory ? null : (
            <View
              style={{
                alignSelf: 'center',
                width: 40,
                height: 4,
                borderRadius: 2,
                backgroundColor: theme.colors.borderStrong,
                marginBottom: theme.spacing.lg,
              }}
            />
          )}

          {title ? (
            <View style={{ marginBottom: theme.spacing.lg }}>
              <Text variant="title">{title}</Text>
              {subtitle ? (
                <Text
                  variant="body"
                  tone="muted"
                  style={{ marginTop: theme.spacing.xs }}
                >
                  {subtitle}
                </Text>
              ) : null}
            </View>
          ) : null}

          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}
