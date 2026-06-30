// Design tokens shared by mobile (react-native StyleSheet) and web (Tailwind/CSS).
// `shadows` are react-native shadow objects — harmless data on web (unused there).
//
// Hustlr Brand Guidelines v2.0 — kept in lockstep with web/app/globals.css so the
// mobile app and website share one visual identity:
//   Electric Blue  #3F25FE — primary brand, backgrounds, buttons, links
//   Hustle Orange  #FFBC45 — accent/money/energy (NEVER white text on this — use dark ink)
//   Action Red     #F21A06 — urgent/destructive, emphasis
//   Canvas Cream   #F7F3EC — page backgrounds, breathing room
//   Ink            #181231 — primary text
export const colors = {
  primary: '#3F25FE',
  primaryDark: '#2B17C2',
  primaryLight: '#E9E6FF',
  secondary: '#5538FF',
  accent: '#FFBC45',        // Hustle Orange — pair with dark ink, never white text
  accentLight: '#FFF1D6',
  accentDeep: '#9A5B00',    // dark amber, for text/icons on light-amber surfaces
  gold: '#FFBC45',
  goldLight: '#FFF1D6',
  urgent: '#F21A06',
  urgentLight: '#FFE7E3',
  background: '#F7F3EC',
  surface: '#FFFFFF',
  textPrimary: '#181231',
  textSecondary: '#5B5570',
  textMuted: '#9A93AD',
  border: '#E8E2D5',
  divider: '#F0EBDF',
  success: '#15803D',
  successLight: '#E7F8EE',
};

export const gradients = {
  primary: ['#3F25FE', '#2B17C2'],
  earn:    ['#4733FF', '#1E2A8F'],
  gold:    ['#5538FF', '#2B17C2'],
  profile: ['#5538FF', '#2B17C2'],
};

// CSS linear-gradient strings for web convenience (mirror of `gradients`).
export const cssGradients = {
  primary: 'linear-gradient(135deg, #3F25FE, #2B17C2)',
  earn: 'linear-gradient(135deg, #4733FF, #1E2A8F)',
  gold: 'linear-gradient(160deg, #5538FF, #2B17C2)',
  profile: 'linear-gradient(135deg, #5538FF, #2B17C2)',
};

export const shadows = {
  sm: {
    shadowColor: '#3F25FE',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2,
  },
  md: {
    shadowColor: '#3F25FE',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 4,
  },
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
};
