// Design tokens shared by mobile (react-native StyleSheet) and web (Tailwind/CSS).
// `shadows` are react-native shadow objects — harmless data on web (unused there).
//
// Hustlr Brand Guidelines v3.0 — kept in lockstep with web/app/globals.css so the
// mobile app and website share one visual identity:
//   Electric Blue  #5038FF — primary brand, backgrounds, buttons, links
//   Action Red     #EA4637 — urgent/destructive, emphasis
//   Canvas Cream   #F7F4EC — page backgrounds, breathing room
//   Ink            #363636 — primary text
//
// v3.0 CHANGES FROM v2.0 (values only — every key is preserved):
//   primary      #3F25FE -> #5038FF
//   urgent       #F21A06 -> #EA4637
//   background   #F7F3EC -> #F7F4EC
//   textPrimary  #181231 -> #363636   (brand Ink; 10.5:1 on canvas)
//   Hustle Orange #FFBC45 is RETIRED as a brand accent. The accent*/gold* keys are
//   kept as DEPRECATED ALIASES pointing at the new semantic amber so nothing breaks;
//   migrate call sites to warning*/wash* (see REBRAND.md stage 3), then delete them.
export const colors = {
  primary: '#5038FF',
  primaryDark: '#2E1BC7',
  primaryLight: '#EAE6FF',
  secondary: '#6B54FF',

  // Semantic amber — lifecycle "pending" only. NOT a brand color.
  warning: '#E0A44A',
  warningLight: '#FDF0DA',
  warningDeep: '#8A5A12',

  // Blue wash — the v3 replacement for orange on money/among-brand surfaces
  // (pay pill, badge tiles, stat chips). Use with washDeep as the text color.
  wash: '#EAE6FF',
  washDeep: '#5038FF',

  // DEPRECATED — Hustle Orange aliases. Retained so existing imports compile.
  // Call sites: JobDetailScreen (payPill, STATUS_CONTENT.pending, statChip),
  // MoneyGoalCard (PACE), BadgeGrid, EarnScreen (nudgeRate).
  accent: '#E0A44A',
  accentLight: '#FDF0DA',
  accentDeep: '#8A5A12',
  gold: '#E0A44A',
  goldLight: '#FDF0DA',

  urgent: '#EA4637',
  urgentLight: '#FFE7E3',
  background: '#F7F4EC',
  surface: '#FFFFFF',
  textPrimary: '#363636',
  textSecondary: '#6B6482',
  textMuted: '#9A93AD',
  border: '#E4DFD3',
  divider: '#EFEBE1',
  success: '#15803D',
  successLight: '#E7F8EE',
};

// Corner-radius system. Three sizes only — mixing 6/8/12/14/16/20/22 across one
// screen is the "AI template" tell we're moving away from. `pill` is for true
// pills (chips, avatars, the tab bar) and nothing else.
// UNCHANGED in v3.0 — the mockups were built to these exact values.
export const radii = {
  sm: 10,   // small inline chips, badges, tags
  md: 14,   // inputs, buttons, controls
  lg: 20,   // cards, panels
  xl: 28,   // bottom sheets / modals
  pill: 999,
};

export const gradients = {
  primary: ['#6B54FF', '#5038FF'],
  earn:    ['#5038FF', '#2E1BC7'],
  gold:    ['#6B54FF', '#3A24D6'],
  profile: ['#6B54FF', '#2E1BC7'],
};

// CSS linear-gradient strings for web convenience (mirror of `gradients`).
export const cssGradients = {
  primary: 'linear-gradient(135deg, #6B54FF, #5038FF)',
  earn: 'linear-gradient(135deg, #5038FF, #2E1BC7)',
  gold: 'linear-gradient(160deg, #6B54FF, #3A24D6)',
  profile: 'linear-gradient(135deg, #6B54FF, #2E1BC7)',
};

// Neutral (black, low-opacity) shadows only — brand-tinted shadows read as "glow"
// and are one of the AI-generated-design tells we're moving away from.
// UNCHANGED in v3.0.
export const shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
  },
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 2,
  },
};
