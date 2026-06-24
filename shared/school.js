// College identity helpers shared by mobile + web.
// Self-reported school/degree fields + the "Verified Student" trust signal.

export const CLASS_STANDINGS = [
  'Freshman',
  'Sophomore',
  'Junior',
  'Senior',
  'Grad Student',
  'Alumni',
];

export const DEGREE_TYPES = [
  'Associate',
  "Bachelor's",
  "Master's",
  'Doctorate (PhD)',
  'Certificate / Bootcamp',
  'Other',
];

// Grad-year choices centered on a reference year (defaults handled by callers,
// which must pass the current year — Date.now() is avoided in shared code so it
// stays deterministic for tests).
export function gradYearOptions(currentYear, back = 6, forward = 6) {
  const out = [];
  for (let y = currentYear + forward; y >= currentYear - back; y--) out.push(y);
  return out;
}

// Curated US university email domains → display names, for instant school naming
// from a .edu address and nicer autocomplete. Not exhaustive — unknown domains
// fall back to the user's free-text school name.
export const COLLEGE_DOMAINS = {
  'utexas.edu': 'University of Texas at Austin',
  'tamu.edu': 'Texas A&M University',
  'rice.edu': 'Rice University',
  'berkeley.edu': 'UC Berkeley',
  'ucla.edu': 'UCLA',
  'ucsd.edu': 'UC San Diego',
  'ucdavis.edu': 'UC Davis',
  'uci.edu': 'UC Irvine',
  'usc.edu': 'University of Southern California',
  'stanford.edu': 'Stanford University',
  'mit.edu': 'MIT',
  'harvard.edu': 'Harvard University',
  'yale.edu': 'Yale University',
  'princeton.edu': 'Princeton University',
  'columbia.edu': 'Columbia University',
  'cornell.edu': 'Cornell University',
  'upenn.edu': 'University of Pennsylvania',
  'brown.edu': 'Brown University',
  'dartmouth.edu': 'Dartmouth College',
  'nyu.edu': 'New York University',
  'bu.edu': 'Boston University',
  'northeastern.edu': 'Northeastern University',
  'umich.edu': 'University of Michigan',
  'wisc.edu': 'University of Wisconsin–Madison',
  'umn.edu': 'University of Minnesota',
  'illinois.edu': 'University of Illinois Urbana-Champaign',
  'purdue.edu': 'Purdue University',
  'iu.edu': 'Indiana University',
  'osu.edu': 'Ohio State University',
  'msu.edu': 'Michigan State University',
  'psu.edu': 'Penn State University',
  'rutgers.edu': 'Rutgers University',
  'umd.edu': 'University of Maryland',
  'virginia.edu': 'University of Virginia',
  'vt.edu': 'Virginia Tech',
  'unc.edu': 'UNC Chapel Hill',
  'duke.edu': 'Duke University',
  'ncsu.edu': 'NC State University',
  'gatech.edu': 'Georgia Tech',
  'uga.edu': 'University of Georgia',
  'ufl.edu': 'University of Florida',
  'fsu.edu': 'Florida State University',
  'miami.edu': 'University of Miami',
  'asu.edu': 'Arizona State University',
  'arizona.edu': 'University of Arizona',
  'colorado.edu': 'University of Colorado Boulder',
  'washington.edu': 'University of Washington',
  'uoregon.edu': 'University of Oregon',
  'ou.edu': 'University of Oklahoma',
  'utah.edu': 'University of Utah',
  'pitt.edu': 'University of Pittsburgh',
  'cmu.edu': 'Carnegie Mellon University',
  'jhu.edu': 'Johns Hopkins University',
  'gwu.edu': 'George Washington University',
  'georgetown.edu': 'Georgetown University',
  'nd.edu': 'University of Notre Dame',
  'vanderbilt.edu': 'Vanderbilt University',
  'emory.edu': 'Emory University',
  'wustl.edu': 'Washington University in St. Louis',
  'uchicago.edu': 'University of Chicago',
  'northwestern.edu': 'Northwestern University',
  'baylor.edu': 'Baylor University',
  'tcu.edu': 'Texas Christian University',
  'ttu.edu': 'Texas Tech University',
  'uh.edu': 'University of Houston',
};

// True for US academic emails (.edu) and common international academic domains.
export function isEduEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return false;
  const domain = e.split('@')[1];
  return (
    domain.endsWith('.edu') ||
    domain.endsWith('.ac.uk') ||
    domain.endsWith('.edu.au') ||
    /\.edu\.[a-z]{2}$/.test(domain)
  );
}

export function schoolDomainFromEmail(email) {
  if (!email || !email.includes('@')) return null;
  return email.trim().toLowerCase().split('@')[1] || null;
}

// Best-effort school name from a domain (curated map, else a title-cased guess).
export function schoolNameFromDomain(domain) {
  if (!domain) return null;
  const d = domain.toLowerCase();
  if (COLLEGE_DOMAINS[d]) return COLLEGE_DOMAINS[d];
  // Strip the academic suffix and title-case the institution slug as a fallback.
  const core = d.replace(/\.(edu|ac\.uk|edu\.[a-z]{2})$/, '').split('.').pop() || d;
  return core.charAt(0).toUpperCase() + core.slice(1);
}

// The trust label to render on a profile/card, or null when not a verified student.
export function studentTrustLabel(profile) {
  if (!profile) return null;
  const verified = profile.studentVerified ?? profile.student_verified;
  if (!verified) return null;
  const status = profile.studentStatus ?? profile.student_status;
  return status === 'alumni' ? 'Verified Alumni' : 'Verified Student';
}

// A compact "School · Class of YYYY" line for profiles (omits empty parts).
export function collegeLine(profile) {
  if (!profile) return null;
  const school = profile.school;
  const grad = profile.gradYear ?? profile.grad_year;
  const major = profile.major;
  const parts = [];
  if (major) parts.push(major);
  if (school) parts.push(school);
  let line = parts.join(' · ');
  if (grad) line = line ? `${line} · Class of ${grad}` : `Class of ${grad}`;
  return line || null;
}
