import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, SafeAreaView, StatusBar } from 'react-native';
import { useTheme, createThemedStyles } from '../theme';
import { useRadarStore } from '../store/useRadarStore';
import { ConnectedHeaderBar } from '../components/common/ConnectedHeaderBar';
import { FeedHealthBanner } from '../components/common/FeedHealthBanner';
import { SignalsScreen } from '../screens/SignalsScreen';
import { RadarScreen } from '../screens/RadarScreen';
import { JournalScreen } from '../screens/JournalScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { OptionChainScreen } from '../screens/OptionChainScreen';
import * as Haptics from 'expo-haptics';

type Tab = 'SIGNALS' | 'RADAR' | 'OPTIONS' | 'JOURNAL' | 'SETTINGS';

export function AppNavigator() {
  const [activeTab, setActiveTab] = useState<Tab>('SIGNALS');
  const signalsTodayCount = useRadarStore((s) => s.signalsTodayCount);
  const { colors, isDark } = useTheme();
  const styles = useThemedStyles();

  const handleTabPress = (tab: Tab) => {
    Haptics.selectionAsync();
    setActiveTab(tab);
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'SIGNALS':
        return <SignalsScreen onNavigateToOptions={() => setActiveTab('OPTIONS')} />;
      case 'RADAR':
        return <RadarScreen onNavigateToSignals={() => setActiveTab('SIGNALS')} />;
      case 'OPTIONS':
        return <OptionChainScreen />;
      case 'JOURNAL':
        return <JournalScreen />;
      case 'SETTINGS':
        return <SettingsScreen />;
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor={colors.obsidian}
      />

      {/* Top Application Header */}
      <ConnectedHeaderBar />
      <FeedHealthBanner onOpenSettings={() => setActiveTab('SETTINGS')} />

      {/* Active Tab Screen Body */}
      <View style={styles.body}>{renderContent()}</View>

      {/* Bottom Navigation Tab Bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabItem, activeTab === 'SIGNALS' && styles.tabItemActive]}
          onPress={() => handleTabPress('SIGNALS')}
        >
          <Text style={[styles.tabIcon, activeTab === 'SIGNALS' && styles.tabIconActive]}>⚡</Text>
          <Text style={[styles.tabLabel, activeTab === 'SIGNALS' && styles.tabLabelActive]}>Signals</Text>
          {signalsTodayCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{signalsTodayCount}</Text>
            </View>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabItem, activeTab === 'RADAR' && styles.tabItemActive]}
          onPress={() => handleTabPress('RADAR')}
        >
          <Text style={[styles.tabIcon, activeTab === 'RADAR' && styles.tabIconActive]}>📡</Text>
          <Text style={[styles.tabLabel, activeTab === 'RADAR' && styles.tabLabelActive]}>Radar</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabItem, activeTab === 'OPTIONS' && styles.tabItemActive]}
          onPress={() => handleTabPress('OPTIONS')}
        >
          <Text style={[styles.tabIcon, activeTab === 'OPTIONS' && styles.tabIconActive]}>📊</Text>
          <Text style={[styles.tabLabel, activeTab === 'OPTIONS' && styles.tabLabelActive]}>Options</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabItem, activeTab === 'JOURNAL' && styles.tabItemActive]}
          onPress={() => handleTabPress('JOURNAL')}
        >
          <Text style={[styles.tabIcon, activeTab === 'JOURNAL' && styles.tabIconActive]}>📜</Text>
          <Text style={[styles.tabLabel, activeTab === 'JOURNAL' && styles.tabLabelActive]}>Journal</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabItem, activeTab === 'SETTINGS' && styles.tabItemActive]}
          onPress={() => handleTabPress('SETTINGS')}
        >
          <Text style={[styles.tabIcon, activeTab === 'SETTINGS' && styles.tabIconActive]}>⚙️</Text>
          <Text style={[styles.tabLabel, activeTab === 'SETTINGS' && styles.tabLabelActive]}>Settings</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const useThemedStyles = createThemedStyles((colors) => ({
  container: {
    flex: 1,
    backgroundColor: colors.obsidian,
  },
  body: {
    flex: 1,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    borderRadius: 8,
    position: 'relative',
  },
  tabItemActive: {
    backgroundColor: colors.surfaceSubtle,
  },
  tabIcon: {
    fontSize: 18,
    marginBottom: 2,
    opacity: 0.6,
  },
  tabIconActive: {
    opacity: 1,
  },
  tabLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '600',
  },
  tabLabelActive: {
    color: colors.bullish,
    fontWeight: '700',
  },
  badge: {
    position: 'absolute',
    top: 2,
    right: 18,
    backgroundColor: colors.bullish,
    borderRadius: 8,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  badgeText: {
    color: colors.obsidian,
    fontSize: 9,
    fontWeight: '800',
  },
}));
