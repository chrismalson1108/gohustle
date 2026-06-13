// `ion` is an Ionicons name (renders reliably everywhere); `icon` kept for any legacy use.
export const CATEGORIES = [
  { id: 'all', label: 'All', icon: '🌟', ion: 'grid' },
  { id: 'Tutoring', label: 'Tutoring', icon: '📚', ion: 'book' },
  { id: 'Delivery', label: 'Delivery', icon: '🚚', ion: 'bicycle' },
  { id: 'Moving', label: 'Moving', icon: '📦', ion: 'cube' },
  { id: 'Tech Help', label: 'Tech Help', icon: '💻', ion: 'laptop' },
  { id: 'Creative', label: 'Creative', icon: '🎨', ion: 'color-palette' },
  { id: 'Odd Jobs', label: 'Odd Jobs', icon: '🛠️', ion: 'construct' },
  { id: 'Errands', label: 'Errands', icon: '🛒', ion: 'cart' },
];

export const CATEGORY_COLORS = {
  Tutoring: '#6366F1',
  Delivery: '#10B981',
  Moving: '#F59E0B',
  'Tech Help': '#3B82F6',
  Creative: '#EC4899',
  'Odd Jobs': '#8B5CF6',
  Errands: '#14B8A6',
};

export const BADGE_DEFS = {
  firstHustle: { icon: '🌟', ion: 'sparkles', label: 'First Hustle', desc: 'Completed your first gig' },
  onFire:      { icon: '🔥', ion: 'flame',    label: 'On Fire',      desc: '5-day hustle streak' },
  bigEarner:   { icon: '💰', ion: 'cash',     label: 'Big Earner',   desc: 'Earned $1,000+' },
  topRated:    { icon: '⭐', ion: 'star',     label: 'Top Rated',    desc: '10 five-star reviews' },
  speedDemon:  { icon: '⚡', ion: 'flash',    label: 'Speed Demon',  desc: 'Applied within 30min of posting' },
};

export const LEVELS = [
  { level: 1, label: 'New Hustler',   minXP: 0,    color: '#94A3B8' },
  { level: 2, label: 'Side Hustler',  minXP: 100,  color: '#4F46E5' },
  { level: 3, label: 'Hustle Pro',    minXP: 300,  color: '#6D28D9' },
  { level: 4, label: 'Hustle Boss',   minXP: 600,  color: '#F59E0B' },
  { level: 5, label: 'Hustle Legend', minXP: 1000, color: '#EF4444' },
];
