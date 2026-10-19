// Zero-Flicker Skeleton Shimmer Loader for Obsidian Dark Terminal
import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, ViewStyle, StyleProp, DimensionValue } from 'react-native';
import { theme as defaultTheme, useTheme } from '../../theme';

export interface SkeletonLoaderProps {
  /** Width of the skeleton element (number or percentage string e.g. '100%') */
  width?: DimensionValue;
  /** Height of the skeleton element */
  height?: DimensionValue;
  /** Border radius of the skeleton element */
  borderRadius?: number;
  /** Number of stacked lines to render */
  lines?: number;
  /** Spacing between stacked lines (when lines > 1) */
  spacing?: number;
  /** Base background color override (defaults to theme surfaceHover) */
  backgroundColor?: string;
  /** Custom container style */
  style?: StyleProp<ViewStyle>;
  /** Test identifier */
  testID?: string;
}

export function SkeletonLoader({
  width = '100%',
  height = 16,
  borderRadius = defaultTheme.borderRadius.sm,
  lines = 1,
  spacing = defaultTheme.spacing.sm,
  backgroundColor,
  style,
  testID,
}: SkeletonLoaderProps): React.JSX.Element {
  const { theme } = useTheme();
  const pulseAnim = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 0.85,
          duration: 850,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0.35,
          duration: 850,
          useNativeDriver: true,
        }),
      ])
    );

    animation.start();

    return () => {
      animation.stop();
    };
  }, [pulseAnim]);

  const baseColor = backgroundColor || theme.colors.surfaceHover;

  if (lines <= 1) {
    return (
      <Animated.View
        testID={testID}
        accessibilityRole="progressbar"
        accessibilityLabel="Loading content"
        style={[
          styles.skeleton,
          {
            width,
            height,
            borderRadius,
            backgroundColor: baseColor,
            opacity: pulseAnim,
          },
          style,
        ]}
      />
    );
  }

  return (
    <View testID={testID} style={[styles.multiContainer, style]}>
      {Array.from({ length: lines }).map((_, idx) => {
        // Slightly vary width of the last line for realistic paragraph skeleton
        const isLast = idx === lines - 1;
        const lineWidth = isLast && typeof width === 'string' && width === '100%' ? '70%' : width;

        return (
          <Animated.View
            key={`skeleton-line-${idx}`}
            testID={testID ? `${testID}-line-${idx}` : undefined}
            accessibilityRole="progressbar"
            accessibilityLabel="Loading line"
            style={[
              styles.skeleton,
              {
                width: lineWidth,
                height,
                borderRadius,
                backgroundColor: baseColor,
                opacity: pulseAnim,
                marginBottom: isLast ? 0 : spacing,
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  skeleton: {
    overflow: 'hidden',
  },
  multiContainer: {
    flexDirection: 'column',
    width: '100%',
  },
});
