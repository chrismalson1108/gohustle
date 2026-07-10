// messages.js imports ./supabase (native ESM chain Jest can't transform); mock it so
// we can unit-test the pure hub-filter helper. Hoisted above the import by babel-jest.
jest.mock('../src/lib/supabase', () => ({ supabase: {} }));
import { notBlocked } from '../src/lib/messages';
const fs = require('fs');
const path = require('path');

describe('H2 block — hub filter (notBlocked)', () => {
  const blocked = new Set(['u-bad']);

  test('hides a conversation with a blocked user', () => {
    expect(notBlocked({ other: { id: 'u-bad' } }, blocked)).toBe(false);
  });

  test('keeps a conversation with a non-blocked user', () => {
    expect(notBlocked({ other: { id: 'u-ok' } }, blocked)).toBe(true);
  });

  test('is a no-op when there are no blocks or no other party', () => {
    expect(notBlocked({ other: { id: 'u-bad' } }, null)).toBe(true);
    expect(notBlocked({ other: null }, blocked)).toBe(true);
    expect(notBlocked({}, blocked)).toBe(true);
  });
});

describe('H2 block — server enforcement stays in the tracked migration', () => {
  const sql = fs
    .readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260710030000_block_enforcement.sql'), 'utf8')
    .toLowerCase();

  test('messages_insert consults blocks via a private SECURITY DEFINER helper (not RLS-defeated, not an RPC oracle)', () => {
    expect(sql).toContain('create policy "messages_insert"');
    // The policy must go through the helper — an inline `select from public.blocks`
    // inside the policy would be filtered by blocks-RLS (owner-scoped) and silently
    // fail to block the blocked party. And the helper must live in the non-exposed
    // `private` schema so it isn't a PostgREST rpc/ oracle over the block graph.
    expect(sql).toContain('not private.is_blocked_pair');
    expect(sql).toMatch(/create or replace function private\.is_blocked_pair/);
    expect(sql).toContain('create schema if not exists private');
    expect(sql).toContain('security definer');
    expect(sql).not.toContain('public.is_blocked_pair'); // must NOT be in the exposed schema
    // Helper checks BOTH directions.
    expect(sql).toMatch(/bl\.blocker_id = a and bl\.blocked_id = b/);
    expect(sql).toMatch(/bl\.blocker_id = b and bl\.blocked_id = a/);
  });

  test('a BEFORE INSERT booking trigger rejects blocked pairs', () => {
    expect(sql).toContain('before insert on public.bookings');
    expect(sql).toContain('guard_booking_not_blocked');
    expect(sql).toContain('you cannot book this gig');
  });
});
