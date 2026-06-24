// Tests the shared college/student helpers (via the mobile re-export shim).
import {
  isEduEmail,
  schoolDomainFromEmail,
  schoolNameFromDomain,
  studentTrustLabel,
  collegeLine,
} from '../src/lib/school';

describe('isEduEmail', () => {
  test('accepts .edu and academic domains', () => {
    expect(isEduEmail('a@utexas.edu')).toBe(true);
    expect(isEduEmail('a@students.ox.ac.uk')).toBe(true);
  });
  test('rejects non-academic / malformed', () => {
    expect(isEduEmail('a@gmail.com')).toBe(false);
    expect(isEduEmail('not-an-email')).toBe(false);
    expect(isEduEmail('')).toBe(false);
    expect(isEduEmail(null)).toBe(false);
  });
});

test('schoolDomainFromEmail extracts the domain', () => {
  expect(schoolDomainFromEmail('chris@utexas.edu')).toBe('utexas.edu');
  expect(schoolDomainFromEmail('bad')).toBe(null);
});

describe('schoolNameFromDomain', () => {
  test('maps known domains', () => {
    expect(schoolNameFromDomain('utexas.edu')).toBe('University of Texas at Austin');
  });
  test('falls back to a title-cased guess', () => {
    expect(schoolNameFromDomain('madeupcollege.edu')).toBe('Madeupcollege');
  });
});

describe('studentTrustLabel', () => {
  test('verified student vs alumni vs none', () => {
    expect(studentTrustLabel({ studentVerified: true, studentStatus: 'student' })).toBe('Verified Student');
    expect(studentTrustLabel({ student_verified: true, student_status: 'alumni' })).toBe('Verified Alumni');
    expect(studentTrustLabel({ studentVerified: false })).toBe(null);
    expect(studentTrustLabel(null)).toBe(null);
  });
});

test('collegeLine composes major · school · Class of YYYY', () => {
  expect(collegeLine({ school: 'UT Austin', major: 'CS', gradYear: 2027 })).toBe('CS · UT Austin · Class of 2027');
  expect(collegeLine({ school: 'UT Austin' })).toBe('UT Austin');
  expect(collegeLine({ grad_year: 2026 })).toBe('Class of 2026');
  expect(collegeLine({})).toBe(null);
});
