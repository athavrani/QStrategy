import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { useTheme, createThemedStyles } from '../../theme';
import { UpdateCheckResult, appUpdateService } from '../../services/appUpdateService';
import * as Haptics from 'expo-haptics';

interface AppUpdateModalProps {
  visible: boolean;
  updateInfo: UpdateCheckResult | null;
  onClose: () => void;
}

export function AppUpdateModal({
  visible,
  updateInfo,
  onClose,
}: AppUpdateModalProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles();

  if (!visible || !updateInfo || !updateInfo.updateAvailable) {
    return null;
  }

  const handleDownload = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await appUpdateService.openApkDownload(updateInfo.apkDownloadUrl);
    onClose();
  };

  const handleDismiss = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    appUpdateService.dismissVersion(updateInfo.latestVersion);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleDismiss}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {/* Header Icon & Title */}
          <View style={styles.header}>
            <View style={styles.iconCircle}>
              <Text style={styles.iconText}>🚀</Text>
            </View>
            <View style={styles.headerTextCol}>
              <Text style={styles.title}>New Version Available</Text>
              <Text style={styles.subtitle}>
                An updated release of QStrategy is ready!
              </Text>
            </View>
          </View>

          {/* Version Comparison Pill */}
          <View style={styles.versionRow}>
            <View style={styles.versionPillOld}>
              <Text style={styles.versionLabel}>Installed</Text>
              <Text style={styles.versionValOld}>
                v{updateInfo.currentVersion} (b{updateInfo.currentVersionCode})
              </Text>
            </View>
            <Text style={styles.versionArrow}>➔</Text>
            <View style={styles.versionPillNew}>
              <Text style={styles.versionLabelNew}>New Release</Text>
              <Text style={styles.versionValNew}>
                v{updateInfo.latestVersion} (b{updateInfo.latestVersionCode})
              </Text>
            </View>
          </View>

          {/* Release Notes */}
          <Text style={styles.sectionHeader}>WHAT'S NEW</Text>
          <ScrollView style={styles.notesBox} nestedScrollEnabled>
            <Text style={styles.notesText}>
              {updateInfo.releaseNotes ||
                '• Performance enhancements & faster option chain updates.\n• Strategy execution improvements.'}
            </Text>
          </ScrollView>

          {/* Action Buttons */}
          <View style={styles.actionsRow}>
            <TouchableOpacity
              style={styles.btnSecondary}
              onPress={handleDismiss}
              activeOpacity={0.7}
            >
              <Text style={styles.btnSecondaryText}>Later</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.btnPrimary}
              onPress={handleDownload}
              activeOpacity={0.8}
            >
              <Text style={styles.btnPrimaryText}>Download & Install</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const useThemedStyles = createThemedStyles((colors) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.78)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: 20,
    },
    card: {
      width: '100%',
      maxWidth: 380,
      backgroundColor: '#0C1019',
      borderRadius: 16,
      borderWidth: 1.5,
      borderColor: 'rgba(16, 185, 129, 0.35)',
      padding: 20,
      shadowColor: '#10B981',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.25,
      shadowRadius: 16,
      elevation: 10,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 16,
      gap: 12,
    },
    iconCircle: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: 'rgba(16, 185, 129, 0.15)',
      borderWidth: 1,
      borderColor: 'rgba(16, 185, 129, 0.4)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    iconText: {
      fontSize: 22,
    },
    headerTextCol: {
      flex: 1,
    },
    title: {
      color: '#FFFFFF',
      fontSize: 17,
      fontWeight: '800',
      letterSpacing: 0.3,
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: 12,
      marginTop: 2,
    },
    versionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: '#070D18',
      borderRadius: 10,
      padding: 10,
      marginBottom: 14,
      borderWidth: 1,
      borderColor: 'rgba(255, 255, 255, 0.06)',
    },
    versionPillOld: {
      flex: 1,
      alignItems: 'center',
    },
    versionPillNew: {
      flex: 1,
      alignItems: 'center',
    },
    versionArrow: {
      color: colors.textMuted,
      fontSize: 14,
      marginHorizontal: 8,
    },
    versionLabel: {
      color: colors.textMuted,
      fontSize: 10,
      fontWeight: '600',
      textTransform: 'uppercase',
    },
    versionLabelNew: {
      color: colors.bullish,
      fontSize: 10,
      fontWeight: '700',
      textTransform: 'uppercase',
    },
    versionValOld: {
      color: colors.textSecondary,
      fontSize: 12,
      fontWeight: '600',
      marginTop: 2,
    },
    versionValNew: {
      color: '#10B981',
      fontSize: 13,
      fontWeight: '800',
      marginTop: 2,
    },
    sectionHeader: {
      color: colors.textMuted,
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 0.8,
      marginBottom: 6,
    },
    notesBox: {
      maxHeight: 120,
      backgroundColor: '#070D18',
      borderRadius: 8,
      padding: 10,
      borderWidth: 1,
      borderColor: 'rgba(255, 255, 255, 0.05)',
      marginBottom: 18,
    },
    notesText: {
      color: '#CBD5E1',
      fontSize: 12,
      lineHeight: 18,
    },
    actionsRow: {
      flexDirection: 'row',
      gap: 10,
    },
    btnSecondary: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: 'rgba(255, 255, 255, 0.12)',
      backgroundColor: 'rgba(255, 255, 255, 0.04)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    btnSecondaryText: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: '600',
    },
    btnPrimary: {
      flex: 2,
      paddingVertical: 12,
      borderRadius: 8,
      backgroundColor: '#10B981',
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#10B981',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 6,
      elevation: 4,
    },
    btnPrimaryText: {
      color: '#080A0F',
      fontSize: 13,
      fontWeight: '800',
      letterSpacing: 0.2,
    },
  })
);
