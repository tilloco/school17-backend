import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { decideOutcome, mergeIntervals, overlapSeconds, recordingAllowed, sessionInterval } from './presence';
import { MockCallProvider } from './mock-provider';
import { LiveKitCallProvider } from './livekit-provider';
import { createCallProvider } from './call-provider.factory';
import { sha256Base64, signHs256, verifyHs256 } from './jwt-hs256';

const d = (s: string) => new Date('2026-11-03T' + s + 'Z');
const START = d('05:00:00');
const END = d('06:00:00');
const base = { startAt: START, endAt: END, opensAt: d('04:55:00'), closesAt: d('06:05:00') };
const sess = (join: string, leave: string | null, seen?: string) => ({ joinedAt: d(join), lastSeenAt: d(seen ?? leave ?? join), leftAt: leave ? d(leave) : null });

describe('presence intervals', () => {
  it('open session ends at lastSeen when stale, now when fresh', () => {
    const open = { joinedAt: d('05:00:00'), lastSeenAt: d('05:10:00'), leftAt: null };
    assert.equal(sessionInterval(open, d('05:10:20'), 45_000).end.toISOString(), d('05:10:20').toISOString());
    assert.equal(sessionInterval(open, d('05:12:00'), 45_000).end.toISOString(), d('05:10:00').toISOString());
  });
  it('merge and overlap', () => {
    const m = mergeIntervals([{ start: d('05:00:00'), end: d('05:10:00') }, { start: d('05:05:00'), end: d('05:20:00') }, { start: d('05:30:00'), end: d('05:40:00') }]);
    assert.equal(m.length, 2);
    assert.equal(overlapSeconds(m, [{ start: d('05:15:00'), end: d('05:35:00') }]), 10 * 60);
  });
});

describe('outcome decision', () => {
  it('both together 50 min => COMPLETED, billable = overlap', () => {
    const o = decideOutcome({ ...base, teacher: [sess('04:58:00', '05:55:00')], student: [sess('05:05:00', '05:55:00')], now: d('06:00:10') });
    assert.equal(o.kind, 'COMPLETED');
    assert.equal(o.billableSeconds, 50 * 60);
  });
  it('billable never exceeds scheduled duration', () => {
    const o = decideOutcome({ ...base, teacher: [sess('04:55:00', '06:05:00')], student: [sess('04:55:00', '06:05:00')], now: d('06:06:00') });
    assert.equal(o.kind, 'COMPLETED');
    assert.equal(o.billableSeconds, 3600);
  });
  it('reconnect gaps are not billed', () => {
    const o = decideOutcome({
      ...base,
      teacher: [sess('05:00:00', '06:00:00')],
      student: [sess('05:00:00', '05:20:00'), sess('05:30:00', '06:00:00')],
      now: d('06:01:00'),
    });
    assert.equal(o.billableSeconds, (20 + 30) * 60);
  });
  it('only teacher present => NO_SHOW_STUDENT; only student => NO_SHOW_TEACHER; nobody => FAILED', () => {
    assert.equal(decideOutcome({ ...base, teacher: [sess('05:00:00', '05:30:00')], student: [], now: d('06:06:00') }).kind, 'NO_SHOW_STUDENT');
    assert.equal(decideOutcome({ ...base, teacher: [], student: [sess('05:00:00', '05:30:00')], now: d('06:06:00') }).kind, 'NO_SHOW_TEACHER');
    const none = decideOutcome({ ...base, teacher: [], student: [], now: d('06:06:00') });
    assert.equal(none.kind, 'FAILED');
    assert.equal(none.note, 'nobody_joined');
  });
  it('both joined but < 5 minutes together => FAILED (technical), flagged for review', () => {
    const o = decideOutcome({ ...base, teacher: [sess('05:00:00', '05:10:00')], student: [sess('05:07:00', '05:20:00')], now: d('06:06:00') });
    assert.equal(o.kind, 'FAILED');
    assert.equal(o.note, 'insufficient_overlap');
  });
  it('PENDING while lesson is running or someone is still connected before the window closes', () => {
    assert.equal(decideOutcome({ ...base, teacher: [sess('05:00:00', null, '05:30:00')], student: [], now: d('05:30:10') }).kind, 'PENDING');
    assert.equal(decideOutcome({ ...base, teacher: [sess('05:00:00', null, '06:00:30')], student: [sess('05:00:00', '05:59:00')], now: d('06:00:40') }).kind, 'PENDING');
  });
  it('a crashed client (stale heartbeat) does not block finalization', () => {
    const o = decideOutcome({ ...base, teacher: [sess('05:00:00', null, '05:40:00')], student: [sess('05:00:00', '05:40:00')], now: d('06:02:00') });
    assert.equal(o.kind, 'COMPLETED');
    assert.equal(o.billableSeconds, 40 * 60);
  });
});

describe('recording policy', () => {
  it('off unless both consent; never with minors', () => {
    assert.deepEqual(recordingAllowed({ anyMinor: false, teacherConsent: null, studentConsent: null }), { allowed: false, reason: 'consent_missing' });
    assert.deepEqual(recordingAllowed({ anyMinor: false, teacherConsent: true, studentConsent: false }), { allowed: false, reason: 'consent_missing' });
    assert.equal(recordingAllowed({ anyMinor: true, teacherConsent: true, studentConsent: true }).allowed, false);
    assert.equal(recordingAllowed({ anyMinor: false, teacherConsent: true, studentConsent: true }).allowed, true);
  });
});

describe('providers', () => {
  const now = new Date('2026-11-03T04:56:00Z');
  it('mock tokens: scoped to one room, expire, die when the room is closed', async () => {
    const p = new MockCallProvider('s');
    const t = await p.mintToken({ roomName: 'r_a', identity: 'p_1', displayName: 'A', ttlSeconds: 600, now, canPublishData: true });
    assert.equal(p.verifyToken(t.token, now)?.room, 'r_a');
    assert.equal(p.verifyToken(t.token, new Date(now.getTime() + 601_000)), null);
    assert.equal(new MockCallProvider('other').verifyToken(t.token, now), null, 'wrong secret');
    await p.closeRoom('r_a');
    assert.equal(p.verifyToken(t.token, now), null);
    await assert.rejects(p.ensureRoom('r_a'));
  });
  it('livekit token has the documented claim structure (UNTESTED against a real server)', async () => {
    const p = new LiveKitCallProvider('wss://lk.example.test', 'APIkey', 'secretsecretsecretsecretsecretsecret');
    const t = await p.mintToken({ roomName: 'r_a', identity: 'p_1', displayName: 'Ali', ttlSeconds: 600, now, canPublishData: true });
    assert.equal(t.url, 'wss://lk.example.test');
    const c = verifyHs256(t.token, 'secretsecretsecretsecretsecretsecret', now)!;
    assert.equal(c.iss, 'APIkey');
    assert.equal(c.sub, 'p_1');
    assert.equal(c.video.room, 'r_a');
    assert.equal(c.video.roomJoin, true);
    assert.equal(c.video.roomAdmin, undefined);
    assert.equal(c.video.roomCreate, undefined);
    assert.equal(c.exp - Math.floor(now.getTime() / 1000), 600);
  });
  it('livekit webhook: signature + body hash verified', () => {
    const secret = 'secretsecretsecretsecretsecretsecret';
    const p = new LiveKitCallProvider('wss://lk.example.test', 'APIkey', secret);
    const body = JSON.stringify({ event: 'participant_joined', room: { name: 'r_a' }, participant: { identity: 'p_1' }, createdAt: 1_790_000_000 });
    const good = signHs256({ iss: 'APIkey', sha256: sha256Base64(body), exp: Math.floor(Date.now() / 1000) + 60 }, secret);
    const ev = p.parseWebhook(body, good);
    assert.deepEqual(ev.map((e) => [e.type, e.roomName, e.identity]), [['participant_joined', 'r_a', 'p_1']]);
    assert.throws(() => p.parseWebhook(body + ' ', good), /hash/);
    assert.throws(() => p.parseWebhook(body, signHs256({ iss: 'APIkey', sha256: sha256Base64(body) }, 'wrong')), /signature/i);
    assert.throws(() => p.parseWebhook(body, undefined));
  });
  it('factory: mock is refused in production; livekit requires env', () => {
    assert.throws(() => createCallProvider({ NODE_ENV: 'production' } as any), /production/);
    assert.throws(() => createCallProvider({ CALL_PROVIDER: 'livekit' } as any), /LIVEKIT_URL/);
    assert.throws(() => createCallProvider({ CALL_PROVIDER: 'zoom' } as any));
    assert.equal(createCallProvider({ NODE_ENV: 'development' } as any).name, 'mock');
    assert.equal(createCallProvider({ CALL_PROVIDER: 'livekit', LIVEKIT_URL: 'wss://x', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' } as any).name, 'livekit');
  });
});
