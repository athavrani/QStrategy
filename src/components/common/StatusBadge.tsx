// Toned Status Badge Component for Strategy States & Latch Indicators
import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, ViewStyle, TextStyle, StyleProp } from 'react-native';
import { theme, useTheme, ThemeColors } from '../../theme';

export type StatusBadgeVariant = 'bullish' | 'bearish' | 'warning' | 'cyan' | 'purple' | 'neutral';
export type StatusBadgeSize = 'sm' | 'md' | 'lg';

export interface StatusBadgeProps {
  /** Text content displayed in the badge pill */
  label: string;
  /** Semantic color variant */
  variant?: StatusBadgeVariant;
  /** Badge dimensions preset */
  size?: StatusBadgeSize;
  /** Optional live indicator circle */
  showDot?: boolean;
  /** Whether the live dot gently pulses */
  pulse?: boolean;
  /** Optional leading icon or emoji */
  icon?: string;
  /** Custom container style */
  style?: StyleProp<ViewStyle>;
  /** Custom label style */
  textStyle?: StyleProp<TextStyle>;
  /** Test identifier */
  testID?: string;
}

function getVariantConfig(colors: ThemeColors): Record<
  StatusBadgeVariant,
  { text: string; bg: string; border: string; dot: string }
> {
  return {
    bullish: {
      text: colors.bullish,
      bg: colors.bullishGlow,
      border: colors.bullish,
      dot: colors.bullish,
    },
    bearish: {
      text: colors.bearish,
      bg: colors.bearishGlow,
      border: colors.bearish,
      dot: colors.bearish,
    },
    warning: {
      text: colors.warning,
      bg: colors.warningGlow,
      border: colors.warning,
      dot: colors.warning,
    },
    cyan: {
      text: colors.cyan,
      bg: colors.cyanGlow,
      border: colors.cyan,
      dot: colors.cyan,
    },
    purple: {
      text: colors.purple,
      bg: colors.purpleGlow,
      border: colors.purple,
      dot: colors.purple,
    },
    neutral: {
      text: colors.textSecondary,
      bg: 'rgba(148, 163, 184, 0.12)',
      border: colors.textMuted,
      dot: colors.textSecondary,
    },
  };
}

const SIZE_CONFIG: Record<
  StatusBadgeSize,
  {
    paddingHorizontal: number;
    paddingVertical: number;
    fontSize: number;
    dotSize: number;
    borderRadius: number;
    gap: number;
  }
> = {
  sm: {
    paddingHorizontal: theme.spacing.xs + 2,
    paddingVertical: 2,
    fontSize: theme.typography.sizes.micro,
    dotSize: 4,
    borderRadius: theme.borderRadius.xs,
    gap: 4,
  },
  md: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 3,
    fontSize: theme.typography.sizes.sm - 1,
    dotSize: 6,
    borderRadius: theme.borderRadius.sm,
    gap: 5,
  },
  lg: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 5,
    fontSize: theme.typography.sizes.md,
    dotSize: 8,
    borderRadius: theme.borderRadius.md,
    gap: 6,
  },
};

export function StatusBadge({
  label,
  variant = 'bullish',
  size = 'md',
  showDot = false,
  pulse = false,
  icon,
  style,
  textStyle,
  testID,
}: StatusBadgeProps): React.JSX.Element {
  const { colors } = useTheme();
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const variantMap = React.useMemo(() => getVariantConfig(colors), [colors]);
  const config = variantMap[variant] || variantMap.neutral;
  const sizeConfig = SIZE_CONFIG[size] || SIZE_CONFIG.md;

  useEffect(() => {
    if (!pulse || !showDot) {
      pulseAnim.setValue(1);
      return;
    }

    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 0.3,
          duration: 750,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 750,
          useNativeDriver: true,
        }),
      ])
    );

    animation.start();

    return () => {
      animation.stop();
    };
  }, [pulse, showDot, pulseAnim]);

  return (
    <View
      testID={testID}
      accessibilityRole="text"
      accessibilityLabel={`${variant} status: ${label}`}
      style={[
        styles.container,
        {
          backgroundColor: config.bg,
          borderColor: config.border,
          paddingHorizontal: sizeConfig.paddingHorizontal,
          paddingVertical: sizeConfig.paddingVertical,
          borderRadius: sizeConfig.borderRadius,
          gap: sizeConfig.gap,
        },
        style,
      ]}
    >
      {showDot && (
        <Animated.View
          testID={testID ? `${testID}-dot` : undefined}
          style={[
            styles.dot,
            {
              width: sizeConfig.dotSize,
              height: sizeConfig.dotSize,
              borderRadius: sizeConfig.dotSize / 2,
              backgroundColor: config.dot,
              opacity: pulse ? pulseAnim : 1,
            },
          ]}
        />
      )}
      {Boolean(icon) && (
        <Text style={[styles.iconText, { fontSize: sizeConfig.fontSize }]}>{icon}</Text>
      )}
      <Text
        style={[
          styles.labelText,
          {
            color: config.text,
            fontSize: sizeConfig.fontSize,
            fontFamily: theme.typography.fontMono,
          },
          textStyle,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: 1,
    overflow: 'hidden',
  },
  dot: {
    flexShrink: 0,
  },
  iconText: {
    marginRight: 2,
  },
  labelText: {
    fontWeight: theme.typography.weights.bold,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
});
