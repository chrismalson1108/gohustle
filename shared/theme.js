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
// v3.0 CHANGES FROM v2.0:
//   primary      #3F25FE -> #5038FF
//   urgent       #F21A06 -> #EA4637
//   background   #F7F3EC -> #F7F4EC
//   textPrimary  #181231 -> #363636   (brand Ink; 10.5:1 on canvas)
//
// Hustle Orange #FFBC45 is RETIRED. The accent/accentLight/accentDeep/gold/goldLight
// keys are GONE, and the four jobs they were doing are now named separately, because
// one amber standing for all of them is what made the retirement hard to unpick:
//   warning*  lifecycle "awaiting action" — still amber, and only this
//   wash*     money + badge surfaces (pay pill, stat chips, badge tiles) — blue tint
//   rating    review stars — still amber, but a score is not a warning
//   primary   gamification (badges, streaks, levels, challenges)
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

  // Rating stars, and nothing else. Amber is the convention for a score, and a score
  // is neither a lifecycle state nor a brand moment — a 5-star review is not a
  // warning, so it does not borrow warning*. Same value the retired accent resolved
  // to, so stars are unchanged on screen.
  rating: '#E0A44A',

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
