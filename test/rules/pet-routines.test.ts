import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

// Pet care routines: what to do for which pets and how it repeats (`petRoutines`, admins and
// members) and the logs of a due day done (`petRoutineLogs`, anyone in the household in their own name). One household with every role: Alice created it (admin by being first), Bob is a member by
// default, Helen and Hank help, Kim is a kid. Mallory is in no household.
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const HELEN = 'helen@example.com';
const HANK = 'hank@example.com';
const KIM = 'kim@example.com';
const MALLORY = 'mallory@example.com';
const MEMBERS = [ALICE, BOB, HELEN, HANK, KIM];
const ROLES = { [HELEN]: 'helper', [HANK]: 'helper', [KIM]: 'kid' };

type Who = 'admin' | 'member' | 'helper' | 'kid' | 'outsider';
const PERSON: Record<Who, string> = { admin: ALICE, member: BOB, helper: HELEN, kid: KIM, outsider: MALLORY };
const EVERYONE: Who[] = ['admin', 'member', 'helper', 'kid', 'outsider'];
const STAFF: Who[] = ['admin', 'member'];
const IN_HOUSEHOLD: Who[] = ['admin', 'member', 'helper', 'kid'];

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-huishouden-rules',
    firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'households/h1'), { name: 'Home', members: MEMBERS, joined: MEMBERS, roles: ROLES, createdAt: 1 });
  });
});

function as(email: string) {
  return env.authenticatedContext(email.split('@')[0], { email, email_verified: true }).firestore();
}

async function seed(path: string, data: Record<string, unknown>) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
}

const expect = (allowed: boolean, p: Promise<unknown>) => (allowed ? assertSucceeds(p) : assertFails(p));

const H = 'households/h1';
// An extra set to undefined leaves the field out.
const plain = (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
const routine = (by: string, extra: Record<string, unknown> = {}) => plain({
  name: 'Scoop litter box', kind: 'scoop', petIds: ['p1', 'p2'], mode: 'fixed', every: 1, unit: 'day', since: '2031-01-01', remind: true, time: '19:00', createdAt: 1, by, ...extra,
});
const log = (by: string, extra: Record<string, unknown> = {}) => plain({ routineId: 'r1', due: '2031-01-06', on: '2031-01-06', at: 5, by, createdAt: 5, ...extra });

describe('petRoutines', () => {
  it.each(EVERYONE)('%s reads routines when in the household', async (who) => {
    await seed(`${H}/petRoutines/r1`, routine(ALICE));
    await expect(IN_HOUSEHOLD.includes(who), getDoc(doc(as(PERSON[who]), `${H}/petRoutines/r1`)));
  });

  it.each(EVERYONE)('%s sets up a routine only as an admin or member', async (who) => {
    const by = PERSON[who];
    await expect(STAFF.includes(who), setDoc(doc(as(by), `${H}/petRoutines/r1`), routine(by)));
  });

  it.each(EVERYONE)('%s changes and removes a routine only as an admin or member', async (who) => {
    await seed(`${H}/petRoutines/r1`, routine(ALICE));
    await expect(STAFF.includes(who), updateDoc(doc(as(PERSON[who]), `${H}/petRoutines/r1`), { remind: false, updatedAt: 2 }));
    await expect(STAFF.includes(who), deleteDoc(doc(as(PERSON[who]), `${H}/petRoutines/r1`)));
  });

  it('takes each way of repeating: after the last time, fixed, on weekdays; one routine for several pets', async () => {
    const db = as(BOB);
    await assertSucceeds(setDoc(doc(db, `${H}/petRoutines/a`), routine(BOB, { name: 'Change litter', kind: 'litter', mode: 'after-done', every: 1, unit: 'week', remind: false })));
    await assertSucceeds(setDoc(doc(db, `${H}/petRoutines/b`), routine(BOB, { mode: 'fixed', every: 2, unit: 'month' })));
    await assertSucceeds(setDoc(doc(db, `${H}/petRoutines/c`), routine(BOB, { name: 'Brush', kind: 'brush', mode: 'weekdays', days: [1, 4], every: undefined, unit: undefined })));
    await assertSucceeds(setDoc(doc(db, `${H}/petRoutines/d`), routine(BOB, { petIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'], kind: 'custom', name: 'Rinse the bowls' })));
    await assertSucceeds(setDoc(doc(db, `${H}/petRoutines/e`), { name: 'Minimal', petIds: ['p1'], mode: 'weekdays', days: [0], since: '2031-01-01', createdAt: 1, by: BOB }));
  });

  it('refuses what the app never writes', async () => {
    const db = as(ALICE);
    const bad = (extra: Record<string, unknown>) => assertFails(setDoc(doc(db, `${H}/petRoutines/r1`), routine(ALICE, extra)));
    await bad({ name: '' });
    await bad({ name: 'x'.repeat(61) });
    await bad({ kind: 'laundry' });
    await bad({ petIds: [] });
    await bad({ petIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'] });
    await bad({ petIds: [''] });
    await bad({ petIds: [3] });
    await bad({ petIds: 'p1' });
    await bad({ mode: 'yearly' });
    await bad({ every: 0 });
    await bad({ every: 100 });
    await bad({ every: 1.5 });
    await bad({ unit: 'year' });
    await bad({ every: undefined });
    await bad({ unit: undefined });
    await bad({ mode: 'weekdays' });
    await bad({ mode: 'weekdays', days: [] });
    await bad({ mode: 'weekdays', days: [7] });
    await bad({ mode: 'weekdays', days: ['mon'] });
    await bad({ since: '2031-1-1' });
    await bad({ since: undefined });
    await bad({ remind: 'yes' });
    await bad({ time: '7pm' });
    await bad({ time: '24:00' });
    await bad({ createdAt: 'now' });
    await bad({ color: 'brown' });
    await assertFails(setDoc(doc(db, `${H}/petRoutines/r2`), { ...routine(ALICE), by: 'x' }));
  });
});

describe('petRoutineLogs', () => {
  it.each(EVERYONE)('%s reads logs when in the household', async (who) => {
    await seed(`${H}/petRoutineLogs/rtn-r1-2031-01-06`, log(ALICE));
    await expect(IN_HOUSEHOLD.includes(who), getDoc(doc(as(PERSON[who]), `${H}/petRoutineLogs/rtn-r1-2031-01-06`)));
  });

  it.each(EVERYONE)('%s marks a routine done in their own name when in the household', async (who) => {
    const by = PERSON[who];
    await expect(IN_HOUSEHOLD.includes(who), setDoc(doc(as(by), `${H}/petRoutineLogs/rtn-r1-2031-01-06`), log(by, { note: 'Fresh bag' })));
  });

  it('a helper or kid never marks one done in someone else\'s name', async () => {
    await assertFails(setDoc(doc(as(HELEN), `${H}/petRoutineLogs/l1`), log(ALICE)));
    await assertFails(setDoc(doc(as(KIM), `${H}/petRoutineLogs/l2`), log(BOB)));
  });

  it.each(EVERYONE)('%s undoes a log someone else wrote only as an admin or member', async (who) => {
    await seed(`${H}/petRoutineLogs/l1`, log(ALICE));
    await expect(STAFF.includes(who), deleteDoc(doc(as(PERSON[who]), `${H}/petRoutineLogs/l1`)));
  });

  it('a due day already done by someone else is never overwritten by a helper or kid', async () => {
    const id = `${H}/petRoutineLogs/rtn-r1-2031-01-06`;
    await seed(id, log(ALICE));
    await assertFails(setDoc(doc(as(HELEN), id), log(HELEN, { note: 'again' })));
    await assertFails(setDoc(doc(as(KIM), id), log(KIM)));
    await assertSucceeds(setDoc(doc(as(BOB), id), log(ALICE, { note: 'fixed', updatedAt: 6 })));
  });

  it('a helper or kid undoes their own log, not anyone else\'s', async () => {
    await seed(`${H}/petRoutineLogs/mine`, log(HELEN));
    await seed(`${H}/petRoutineLogs/kids`, log(KIM));
    await seed(`${H}/petRoutineLogs/theirs`, log(ALICE));
    await assertFails(deleteDoc(doc(as(HELEN), `${H}/petRoutineLogs/theirs`)));
    await assertSucceeds(deleteDoc(doc(as(HELEN), `${H}/petRoutineLogs/mine`)));
    await assertSucceeds(deleteDoc(doc(as(KIM), `${H}/petRoutineLogs/kids`)));
  });

  it('takes one from the assistant, and refuses what the app never writes', async () => {
    const db = as(HELEN);
    await assertSucceeds(setDoc(doc(db, `${H}/petRoutineLogs/via`), log(HELEN, { via: 'assistant' })));
    const bad = (extra: Record<string, unknown>) => assertFails(setDoc(doc(db, `${H}/petRoutineLogs/x`), log(HELEN, extra)));
    await bad({ routineId: '' });
    await bad({ due: 'Monday' });
    await bad({ on: undefined });
    await bad({ at: '5' });
    await bad({ note: 'x'.repeat(201) });
    await bad({ via: 'portal' });
    await bad({ color: 'brown' });
  });
});

describe('a Pet reminder about a routine', () => {
  const reminder = (by: string, source: unknown) => ({
    app: 'pet',
    title: 'Scoop litter box · Miso',
    body: '',
    at: 1700000000000,
    url: 'https://huishouden-piekstra.web.app/pet/',
    recipients: [ALICE, BOB, HELEN],
    ref: 'pet:routine:r1',
    private: false,
    source,
    sent: false,
    createdAt: 1700000000000,
    by,
  });
  const source = { checks: [{ doc: 'petRoutines/r1' }, { doc: 'petRoutineLogs/rtn-r1-2023-11-14', absent: true }] };

  it('names the routine and the due day\'s log as what it is about, for members and helpers', async () => {
    await assertSucceeds(setDoc(doc(as(ALICE), `${H}/reminders/r1`), reminder(ALICE, source)));
    await assertSucceeds(setDoc(doc(as(HELEN), `${H}/reminders/r2`), reminder(HELEN, source)));
  });

  it('only from Pet, and only its own routine collections', async () => {
    await assertFails(setDoc(doc(as(ALICE), `${H}/reminders/r3`), { ...reminder(ALICE, source), app: 'home' }));
    await assertFails(setDoc(doc(as(ALICE), `${H}/reminders/r4`), reminder(ALICE, { checks: [{ doc: 'petRoutineLogs/x/y/z' }] })));
  });
});
