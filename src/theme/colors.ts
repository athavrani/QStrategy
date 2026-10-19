// Obsidian & Terminal Dark Palette for QStrategy Radar & Trading Terminal
// Strict conformance with Dhan-grade high-contrast financial dark theme

export const colors = {
  // Base Canvas & Surfaces
  obsidian: '#080A0F',        // Pure black-blue terminal background
  surface: '#0F131D',         // Primary card background
  surfaceElevated: '#171D2B', // Modals, popups, and elevated dropdowns
  surfaceSubtle: '#121622',   // Table headers and KPI bars
  surfaceHover: '#1F293D',    // Pressed and hover states
  card: '#111722',            // Card container background
  cardBorder: '#1E293B',      // Card stroke
  border: '#1F293D',          // Subtle container borders
  borderActive: '#3B82F6',    // Active element / focused input highlight
  divider: '#1E293B',         // Section dividers

  // Semantic Financial Signals & Accents
  bullish: '#10B981',         // Emerald green: Profit, BUY, Crossovers, Up-ticks
  bullishGlow: 'rgba(16, 185, 129, 0.15)',
  bearish: '#EF4444',         // Crimson red: Loss, Breakdown, Stop-loss, Down-ticks
  bearishGlow: 'rgba(239, 68, 68, 0.15)',
  warning: '#F59E0B',         // Amber gold: Near-cross, Pre-market, Expiry skip warnings
  warningGlow: 'rgba(245, 158, 11, 0.15)',
  cyan: '#06B6D4',            // Cyan blue: Breakouts, Momentum, Target points
  cyanGlow: 'rgba(6, 182, 212, 0.15)',
  purple: '#8B5CF6',          // Violet purple: Overnight strangle status, Multi-leg tags
  purpleGlow: 'rgba(139, 92, 246, 0.15)',

  // Typography
  textPrimary: '#F9FAFB',     // High-contrast headings and prices
  textSecondary: '#94A3B8',   // Subtitles, metadata, and column headers
  textMuted: '#64748B',       // Invariant hints, timestamps, and muted labels
  textDisabled: '#475569',    // Disabled controls

  // Accent & Brand
  brandYellow: '#FACC15',
  brandYellowSubtle: 'rgba(250, 204, 21, 0.12)',

  // Overlays
  overlay: 'rgba(3, 7, 18, 0.85)',
};

export type ThemeColors = typeof colors;
