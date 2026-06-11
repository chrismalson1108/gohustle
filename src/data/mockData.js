export const CATEGORIES = [
  { id: 'all', label: 'All', icon: '🌟' },
  { id: 'Tutoring', label: 'Tutoring', icon: '📚' },
  { id: 'Delivery', label: 'Delivery', icon: '🚚' },
  { id: 'Moving', label: 'Moving', icon: '📦' },
  { id: 'Tech Help', label: 'Tech Help', icon: '💻' },
  { id: 'Creative', label: 'Creative', icon: '🎨' },
  { id: 'Odd Jobs', label: 'Odd Jobs', icon: '🛠️' },
  { id: 'Errands', label: 'Errands', icon: '🛒' },
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
  firstHustle: { icon: '🌟', label: 'First Hustle', desc: 'Completed your first gig' },
  onFire:      { icon: '🔥', label: 'On Fire',      desc: '5-day hustle streak' },
  bigEarner:   { icon: '💰', label: 'Big Earner',   desc: 'Earned $1,000+' },
  topRated:    { icon: '⭐', label: 'Top Rated',    desc: '10 five-star reviews' },
  speedDemon:  { icon: '⚡', label: 'Speed Demon',  desc: 'Applied within 30min of posting' },
};

export const LEVELS = [
  { level: 1, label: 'New Hustler',   minXP: 0,    color: '#94A3B8' },
  { level: 2, label: 'Side Hustler',  minXP: 100,  color: '#4F46E5' },
  { level: 3, label: 'Hustle Pro',    minXP: 300,  color: '#6D28D9' },
  { level: 4, label: 'Hustle Boss',   minXP: 600,  color: '#F59E0B' },
  { level: 5, label: 'Hustle Legend', minXP: 1000, color: '#EF4444' },
];

export const MOCK_JOBS = [
  {
    id: '1',
    title: 'Math Tutor Needed (Calc II)',
    description: 'Looking for a patient tutor for Calculus II — integration techniques and series. Prefer campus library meetups, flexible on evenings.',
    pay: 25, payType: 'hourly', estimatedHours: 2,
    location: 'UT Austin Campus', category: 'Tutoring',
    poster: { name: 'Sarah M.', avatarInitial: 'S', rating: 4.9, reviewCount: 12, verified: true },
    postedAt: '2h ago', urgent: false, status: 'open',
    requirements: ['Strong Calc II background', 'Patient teaching style'],
    slots: [
      { id: 's1', label: 'Mon Jun 16, 5pm', taken: false },
      { id: 's2', label: 'Tue Jun 17, 6pm', taken: false },
      { id: 's3', label: 'Wed Jun 18, 4pm', taken: true },
    ],
    reviews: [
      { id: 'r1', author: 'Jake T.', rating: 5, text: 'Sarah was super clear about what she needed. Paid immediately!', date: '2 weeks ago' },
      { id: 'r2', author: 'Mia K.', rating: 5, text: 'Very organized, had all materials ready. Great experience.', date: '1 month ago' },
    ],
  },
  {
    id: '2',
    title: 'Help Moving This Saturday',
    description: "Moving from a 1BR to a house nearby. Need 2–3 people for ~4 hours. Truck is rented. I'll provide pizza and drinks!",
    pay: 80, payType: 'flat', estimatedHours: 4,
    location: 'East Austin, TX', category: 'Moving',
    poster: { name: 'Jake T.', avatarInitial: 'J', rating: 4.7, reviewCount: 5, verified: true },
    postedAt: '4h ago', urgent: true, status: 'open',
    requirements: ['Must lift 50+ lbs', 'Available all day Saturday'],
    slots: [
      { id: 's1', label: 'Sat Jun 15, 9am', taken: false },
      { id: 's2', label: 'Sat Jun 15, 11am', taken: false },
    ],
    reviews: [
      { id: 'r1', author: 'Luis R.', rating: 4, text: 'Good job, easy to work with. Quick Venmo payment.', date: '3 weeks ago' },
    ],
  },
  {
    id: '3',
    title: 'Logo Design for New Food Truck',
    description: 'Need a fun, eye-catching logo — vibrant and modern. Full creative freedom. Deliver 3 concepts + 2 revision rounds.',
    pay: 150, payType: 'flat', estimatedHours: 5,
    location: 'Remote OK', category: 'Creative',
    poster: { name: 'Maria G.', avatarInitial: 'M', rating: 4.8, reviewCount: 18, verified: true },
    postedAt: '1d ago', urgent: false, status: 'open',
    requirements: ['Portfolio required', '3 concepts, 2 revisions'],
    slots: [{ id: 's1', label: 'Flexible — Remote', taken: false }],
    reviews: [
      { id: 'r1', author: 'Sam P.', rating: 5, text: 'Maria gave great feedback. Super professional. Quick payment!', date: '1 week ago' },
      { id: 'r2', author: 'Dana C.', rating: 5, text: 'Loved working with her. Very clear creative vision.', date: '2 weeks ago' },
    ],
  },
  {
    id: '4',
    title: 'Fix My WordPress Site',
    description: "Checkout page is down after an update. Need someone with PHP/WordPress experience to fix it ASAP.",
    pay: 50, payType: 'flat', estimatedHours: 2,
    location: 'Remote', category: 'Tech Help',
    poster: { name: 'David K.', avatarInitial: 'D', rating: 4.6, reviewCount: 7, verified: false },
    postedAt: '3h ago', urgent: true, status: 'open',
    requirements: ['PHP/WordPress experience', 'Available for screen share'],
    slots: [
      { id: 's1', label: 'Today, anytime', taken: false },
      { id: 's2', label: 'Tomorrow morning', taken: false },
    ],
    reviews: [
      { id: 'r1', author: 'Tyler M.', rating: 4, text: 'Quick response, gave clear details about the issue.', date: '1 month ago' },
    ],
  },
  {
    id: '5',
    title: 'Weekly Grocery & Pharmacy Runs',
    description: 'Elderly neighbor needs weekly grocery and pharmacy runs. ~1–2 hrs/week. Purchases reimbursed + hourly pay.',
    pay: 20, payType: 'hourly', estimatedHours: 2,
    location: 'North Austin, TX', category: 'Errands',
    poster: { name: 'Linda H.', avatarInitial: 'L', rating: 5.0, reviewCount: 31, verified: true },
    postedAt: '6h ago', urgent: false, status: 'open',
    requirements: ['Must have a car', 'Reliable and punctual'],
    slots: [
      { id: 's1', label: 'Saturday mornings', taken: false },
      { id: 's2', label: 'Sunday mornings', taken: false },
    ],
    reviews: [
      { id: 'r1', author: 'Jordan B.', rating: 5, text: 'Linda is the sweetest employer. Always has a list ready. 10/10.', date: '3 days ago' },
      { id: 'r2', author: 'Aria T.', rating: 5, text: 'Consistent, easy, pays via Venmo on the spot.', date: '2 weeks ago' },
    ],
  },
  {
    id: '6',
    title: 'Hang TV & Picture Frames',
    description: "Need help wall-mounting a 65\" TV and 6 picture frames in my living room. All hardware + stud finder provided.",
    pay: 40, payType: 'flat', estimatedHours: 2,
    location: 'Cedar Park, TX', category: 'Odd Jobs',
    poster: { name: 'Karen O.', avatarInitial: 'K', rating: 4.9, reviewCount: 15, verified: true },
    postedAt: '8h ago', urgent: false, status: 'open',
    requirements: ['Experience with power tools', 'Detail-oriented'],
    slots: [
      { id: 's1', label: 'Mon Jun 16, 2pm', taken: false },
      { id: 's2', label: 'Tue Jun 17, 3pm', taken: false },
    ],
    reviews: [
      { id: 'r1', author: 'Josh M.', rating: 5, text: 'Karen was so prepared and tipped extra for clean work!', date: '5 days ago' },
    ],
  },
  {
    id: '7',
    title: 'Yard Work & Leaf Cleanup',
    description: 'Raking, bagging, light weeding and hedge trimming. ~2–3 hours. All tools provided.',
    pay: 60, payType: 'flat', estimatedHours: 3,
    location: 'Round Rock, TX', category: 'Odd Jobs',
    poster: { name: 'Tom W.', avatarInitial: 'T', rating: 4.5, reviewCount: 9, verified: false },
    postedAt: '5h ago', urgent: false, status: 'open',
    requirements: ['Physical outdoor work', 'Tools provided'],
    slots: [
      { id: 's1', label: 'Sat Jun 15, 8am', taken: false },
      { id: 's2', label: 'Sun Jun 16, 9am', taken: false },
    ],
    reviews: [
      { id: 'r1', author: 'Camille R.', rating: 4, text: 'Easy to find, paid cash same day. Would recommend.', date: '1 month ago' },
    ],
  },
  {
    id: '8',
    title: 'Dog Walking (3x/week)',
    description: "Looking for a reliable walker for my golden retriever Max. 30–45 min walks, 3x/week mornings. Max is super friendly!",
    pay: 18, payType: 'hourly', estimatedHours: 1,
    location: 'South Austin, TX', category: 'Errands',
    poster: { name: 'Becca J.', avatarInitial: 'B', rating: 5.0, reviewCount: 22, verified: true },
    postedAt: '12h ago', urgent: false, status: 'open',
    requirements: ['Dog lover', 'Mon/Wed/Fri 7–9am', 'Daily photo update'],
    slots: [
      { id: 's1', label: 'Mon/Wed/Fri 7am', taken: false },
      { id: 's2', label: 'Mon/Wed/Fri 8am', taken: false },
    ],
    reviews: [
      { id: 'r1', author: 'Omar A.', rating: 5, text: 'Best employer! Max is adorable. Venmos right after every walk.', date: '2 days ago' },
      { id: 'r2', author: 'Lily T.', rating: 5, text: 'Super easy recurring gig. Becca is so organized.', date: '1 week ago' },
    ],
  },
  {
    id: '9',
    title: 'Video Editing for YouTube Channel',
    description: 'Cooking channel. 2–3 videos/month. Raw ~30min → edit to 8–10min. Clean cuts, captions, color grade.',
    pay: 100, payType: 'flat', estimatedHours: 4,
    location: 'Remote', category: 'Creative',
    poster: { name: 'Priya S.', avatarInitial: 'P', rating: 4.8, reviewCount: 11, verified: true },
    postedAt: '2d ago', urgent: false, status: 'open',
    requirements: ['Premiere Pro or DaVinci Resolve', 'Portfolio required', '3-day turnaround'],
    slots: [{ id: 's1', label: 'Flexible — Remote', taken: false }],
    reviews: [
      { id: 'r1', author: 'Sam K.', rating: 5, text: 'Priya gives great direction and pays on delivery. Recurring gig!', date: '1 week ago' },
    ],
  },
  {
    id: '10',
    title: 'Spanish Tutoring (Conversational)',
    description: 'Preparing for a trip. Looking for a native/near-native speaker for 2x/week Zoom sessions.',
    pay: 20, payType: 'hourly', estimatedHours: 1,
    location: 'Zoom / Remote', category: 'Tutoring',
    poster: { name: 'Alex P.', avatarInitial: 'A', rating: 4.7, reviewCount: 4, verified: true },
    postedAt: '1d ago', urgent: false, status: 'open',
    requirements: ['Native or near-native Spanish', 'Patient and conversational'],
    slots: [
      { id: 's1', label: 'Mon/Wed 7pm', taken: false },
      { id: 's2', label: 'Tue/Thu 6pm', taken: false },
    ],
    reviews: [],
  },
];
