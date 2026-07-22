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

// Badge groups, in display order. Used by the Trophy Case to section the list.
export const BADGE_GROUPS = [
  { id: 'work',       label: 'Work' },
  { id: 'earnings',   label: 'Earnings' },
  { id: 'reputation', label: 'Reputation' },
  { id: 'style',      label: 'Style' },
  { id: 'hiring',     label: 'Hiring' },
  { id: 'trust',      label: 'Trust' },
];

// Pure display metadata. The rules that decide whether each one is earned live
// in shared/badges.js — every badge here MUST have a matching rule there
// (enforced by __tests__/badges.test.js).
export const BADGE_DEFS = {
  // ── Work milestones ──────────────────────────────────────────────────────
  firstHustle:  { icon: '🌟', ion: 'sparkles',        label: 'First Hustle',   desc: 'Complete your first gig',                 group: 'work' },
  tenGigs:      { icon: '🎯', ion: 'checkmark-done',  label: 'Double Digits',  desc: 'Complete 10 gigs',                        group: 'work' },
  quarterTon:   { icon: '🏗️', ion: 'construct',       label: 'Journeyman',     desc: 'Complete 25 gigs',                        group: 'work' },
  centurion:    { icon: '💯', ion: 'trophy',          label: 'Centurion',      desc: 'Complete 100 gigs',                       group: 'work' },

  // ── Earnings ─────────────────────────────────────────────────────────────
  firstHundred: { icon: '💵', ion: 'wallet',          label: 'First $100',     desc: 'Earn your first $100',                    group: 'earnings' },
  bigEarner:    { icon: '💰', ion: 'cash',            label: 'Big Earner',     desc: 'Earn $1,000 total',                       group: 'earnings' },
  highRoller:   { icon: '🤑', ion: 'diamond',         label: 'High Roller',    desc: 'Earn $5,000 total',                       group: 'earnings' },
  wellTipped:   { icon: '🎁', ion: 'gift',            label: 'Well Tipped',    desc: 'Receive a tip from a client',             group: 'earnings' },

  // ── Reputation ───────────────────────────────────────────────────────────
  fiveStar:     { icon: '⭐', ion: 'star',            label: 'Five Star',      desc: 'Earn your first 5-star review',           group: 'reputation' },
  topRated:     { icon: '🏅', ion: 'ribbon',          label: 'Top Rated',      desc: 'Earn 10 five-star reviews',               group: 'reputation' },
  crowdPleaser: { icon: '👏', ion: 'people',          label: 'Crowd Pleaser',  desc: 'Earn 25 reviews',                         group: 'reputation' },
  onFire:       { icon: '🔥', ion: 'flame',           label: 'On Fire',        desc: 'Hit a 5-week hustle streak',              group: 'reputation' },
  unstoppable:  { icon: '🚀', ion: 'rocket',          label: 'Unstoppable',    desc: 'Hit a 10-week hustle streak',             group: 'reputation' },

  // ── Style / flavour ──────────────────────────────────────────────────────
  speedDemon:   { icon: '⚡', ion: 'flash',           label: 'Speed Demon',    desc: 'Apply within 30 min of a gig posting',    group: 'style' },
  earlyBird:    { icon: '🌅', ion: 'sunny',           label: 'Early Bird',     desc: 'Finish a gig that starts before 8am',     group: 'style' },
  nightOwl:     { icon: '🦉', ion: 'moon',            label: 'Night Owl',      desc: 'Finish a gig that starts after 8pm',      group: 'style' },
  weekendWared: { icon: '🏕️', ion: 'calendar',        label: 'Weekend Warrior',desc: 'Finish 5 gigs on a weekend',              group: 'style' },
  jackOfAll:    { icon: '🧰', ion: 'color-palette',   label: 'Jack of All',    desc: 'Work gigs in 5 different categories',     group: 'style' },
  regular:      { icon: '🤝', ion: 'repeat',          label: 'The Regular',    desc: 'Work for the same client 3 times',        group: 'style' },
  negotiator:   { icon: '📈', ion: 'trending-up',     label: 'Negotiator',     desc: 'Get a counter-offer accepted',            group: 'style' },

  // ── Hiring (poster side) ─────────────────────────────────────────────────
  firstPost:    { icon: '📣', ion: 'megaphone',       label: 'Now Hiring',     desc: 'Post your first gig',                     group: 'hiring' },
  goodBoss:     { icon: '👔', ion: 'briefcase',       label: 'Good Boss',      desc: 'Verify 5 completed bookings',             group: 'hiring' },
  bigSpender:   { icon: '🏦', ion: 'card',            label: 'Big Spender',    desc: 'Pay out $1,000 to hustlers',              group: 'hiring' },
  tipper:       { icon: '💝', ion: 'heart',           label: 'Generous',       desc: 'Tip on 3 different jobs',                 group: 'hiring' },

  // ── Trust / profile ──────────────────────────────────────────────────────
  idVerified:   { icon: '🛡️', ion: 'shield-checkmark',label: 'Verified',       desc: 'Verify your identity',                    group: 'trust' },
  allStar:      { icon: '✨', ion: 'person-circle',   label: 'All Star',       desc: 'Complete your profile',                   group: 'trust' },
  connector:    { icon: '🔗', ion: 'link',            label: 'Connector',      desc: 'Refer a friend who joins',                group: 'trust' },
};

export const LEVELS = [
  { level: 1, label: 'New Hustler',   minXP: 0,    color: '#94A3B8' },
  { level: 2, label: 'Side Hustler',  minXP: 100,  color: '#4F46E5' },
  { level: 3, label: 'Hustle Pro',    minXP: 300,  color: '#6D28D9' },
  { level: 4, label: 'Hustle Boss',   minXP: 600,  color: '#F59E0B' },
  { level: 5, label: 'Hustle Legend', minXP: 1000, color: '#EF4444' },
];
