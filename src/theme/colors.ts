// Obsidian & Terminal Dark Palette and Clean Financial Light Palette
// High-contrast financial grade tokens for QStrategy Terminal

export const darkColors = {
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
  bullishSubtle: 'rgba(16, 185, 129, 0.15)',
  bearish: '#EF4444',         // Crimson red: Loss, Breakdown, Stop-loss, Down-ticks
  bearishGlow: 'rgba(239, 68, 68, 0.15)',
  bearishSubtle: 'rgba(239, 68, 68, 0.15)',
  warning: '#F59E0B',         // Amber gold: Near-cross, Pre-market, Expiry skip warnings
  warningGlow: 'rgba(245, 158, 11, 0.15)',
  warningSubtle: 'rgba(245, 158, 11, 0.15)',
  cyan: '#06B6D4',            // Cyan blue: Breakouts, Momentum, Target points
  cyanGlow: 'rgba(6, 182, 212, 0.15)',
  cyanSubtle: 'rgba(6, 182, 212, 0.15)',
  purple: '#8B5CF6',          // Violet purple: Overnight strangle status, Multi-leg tags
  purpleGlow: 'rgba(139, 92, 246, 0.15)',
  purpleSubtle: 'rgba(139, 92, 246, 0.15)',

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

export const lightColors = {
  // Base Canvas & Surfaces (Clean Slate Financial)
  obsidian: '#F8FAFC',        // Slate-50: Crisp, clean light canvas
  surface: '#FFFFFF',         // Pure white card background
  surfaceElevated: '#FFFFFF', // Modals, popups, and elevated dropdowns
  surfaceSubtle: '#F1F5F9',   // Slate-100: Table headers, chips, and KPI bars
  surfaceHover: '#E2E8F0',    // Slate-200: Pressed and hover states
  card: '#FFFFFF',            // Card container background
  cardBorder: '#E2E8F0',      // Slate-200: Card stroke
  border: '#E2E8F0',          // Subtle container borders
  borderActive: '#2563EB',    // Blue-600: Active element / focused input highlight
  divider: '#E2E8F0',         // Section dividers

  // Semantic Financial Signals & Accents (High contrast on white backgrounds)
  bullish: '#059669',         // Emerald-600: High-contrast green
  bullishGlow: 'rgba(5, 150, 105, 0.12)',
  bullishSubtle: 'rgba(5, 150, 105, 0.12)',
  bearish: '#DC2626',         // Red-600: High-contrast crimson
  bearishGlow: 'rgba(220, 38, 38, 0.12)',
  bearishSubtle: 'rgba(220, 38, 38, 0.12)',
  warning: '#D97706',         // Amber-600: High-contrast gold
  warningGlow: 'rgba(217, 119, 6, 0.12)',
  warningSubtle: 'rgba(217, 119, 6, 0.12)',
  cyan: '#0891B2',            // Cyan-600: Deep cyan for breakouts
  cyanGlow: 'rgba(8, 145, 178, 0.12)',
  cyanSubtle: 'rgba(8, 145, 178, 0.12)',
  purple: '#7C3AED',          // Violet-600: Deep purple for multi-leg strategies
  purpleGlow: 'rgba(124, 58, 237, 0.12)',
  purpleSubtle: 'rgba(124, 58, 237, 0.12)',

  // Typography (Dark Slate)
  textPrimary: '#0F172A',     // Slate-900: High-contrast headings and prices
  textSecondary: '#475569',   // Slate-600: Subtitles, metadata, and column headers
  textMuted: '#64748B',       // Slate-500: Invariant hints, timestamps, and muted labels
  textDisabled: '#94A3B8',    // Slate-400: Disabled controls

  // Accent & Brand
  brandYellow: '#CA8A04',     // Yellow-600: High-contrast gold
  brandYellowSubtle: 'rgba(202, 138, 4, 0.12)',

  // Overlays
  overlay: 'rgba(15, 23, 42, 0.60)',
};

// Default static export for backward compatibility
export const colors = darkColors;
export type ThemeColors = typeof darkColors;
