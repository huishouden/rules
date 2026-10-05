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

// Pet outings: each pet's plan (`petOutingPlans`, admins and members) and the outings logged
// (`petOutings`, anyone in the household in their own name). One household with every role: Alice created it (admin by being first), Bob is a member by
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
const plan = (by: string, extra: Record<string, unknown> = {}) => ({
  on: true, mode: 'meals', poopMin: 2, flagDays: 2, remind: true, createdAt: 1, by, ...extra,
});
const outing = (by: string, extra: Record<string, unknown> = {}) => ({
  petId: 'p1', slot: 'meal-m1', at: 5, pee: true, poop: true, by, createdAt: 5, ...extra,
});

describe('petOutingPlans', () => {
  it.each(EVERYONE)('%s reads a plan when in the household', async (who) => {
    await seed(`${H}/petOutingPlans/p1`, plan(ALICE));
    await expect(IN_HOUSEHOLD.includes(who), getDoc(doc(as(PERSON[who]), `${H}/petOutingPlans/p1`)));
  });

  it.each(EVERYONE)('%s sets up a plan only as an admin or member', async (who) => {
    const by = PERSON[who];
    await expect(STAFF.includes(who), setDoc(doc(as(by), `${H}/petOutingPlans/p1`), plan(by)));
  });

  it.each(EVERYONE)('%s removes a plan only as an admin or member', async (who) => {
    await seed(`${H}/petOutingPlans/p1`, plan(ALICE));
    await expect(STAFF.includes(who), deleteDoc(doc(as(PERSON[who]), `${H}/petOutingPlans/p1`)));
  });

  it('takes every schedule and setting the app writes', async () => {
    const db = as(BOB);
    await assertSucceeds(setDoc(doc(db, `${H}/petOutingPlans/p1`), plan(BOB, { mode: 'times', times: ['07:00', '12:30', '18:00'] })));
    await assertSucceeds(setDoc(doc(db, `${H}/petOutingPlans/p2`), plan(BOB, { mode: 'every', every: 4, from: '07:00', to: '21:00', walkGoal: 30, updatedAt: 2 })));
    await assertSucceeds(setDoc(doc(db, `${H}/petOutingPlans/p3`), { on: false, mode: 'meals', createdAt: 1, by: BOB }));
    await assertSucceeds(setDoc(doc(db, `${H}/petOutingPlans/p4`), plan(BOB, { mode: 'times', times: ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00', '08:00'] })));
  });

  it('refuses what the app never writes', async () => {
    const db = as(ALICE);
    const bad = (extra: Record<string, unknown>) => assertFails(setDoc(doc(db, `${H}/petOutingPlans/p1`), plan(ALICE, extra)));
    await bad({ on: 'yes' });
    await bad({ mode: 'hourly' });
    await bad({ times: ['7am'] });
    await bad({ times: ['24:00'] });
    await bad({ times: ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00', '08:00', '09:00'] });
    await bad({ times: '07:00' });
    await bad({ every: 0 });
    await bad({ every: 13 });
    await bad({ every: 2.5 });
    await bad({ from: '7:00' });
    await bad({ to: '25:00' });
    await bad({ poopMin: -1 });
    await bad({ poopMin: 11 });
    await bad({ flagDays: 0 });
    await bad({ flagDays: 15 });
    await bad({ remind: 1 });
    await bad({ walkGoal: 601 });
    await bad({ trackWalks: true });
    await bad({ createdAt: 'now' });
    await assertFails(setDoc(doc(db, `${H}/petOutingPlans/p1`), { mode: 'meals', createdAt: 1, by: ALICE }));
  });
});

describe('petOutings', () => {
  it.each(EVERYONE)('%s reads outings when in the household', async (who) => {
    await seed(`${H}/petOutings/o1`, outing(ALICE));
    await expect(IN_HOUSEHOLD.includes(who), getDoc(doc(as(PERSON[who]), `${H}/petOutings/o1`)));
  });

  it.each(EVERYONE)('%s logs an outing in their own name when in the household', async (who) => {
    const by = PERSON[who];
    await expect(IN_HOUSEHOLD.includes(who), setDoc(doc(as(by), `${H}/petOutings/out-p1-2031-05-14-meal-m1`), outing(by)));
  });

  it('a helper or kid never logs one in someone else\'s name', async () => {
    await assertFails(setDoc(doc(as(HELEN), `${H}/petOutings/o1`), outing(ALICE)));
    await assertFails(setDoc(doc(as(KIM), `${H}/petOutings/o2`), outing(BOB)));
  });

  it('a helper changes and removes their own outings, not anyone else\'s', async () => {
    await seed(`${H}/petOutings/mine`, outing(HELEN));
    await seed(`${H}/petOutings/theirs`, outing(ALICE));
    const db = as(HELEN);
    await assertSucceeds(updateDoc(doc(db, `${H}/petOutings/mine`), { poop: false, updatedAt: 6 }));
    await assertFails(updateDoc(doc(db, `${H}/petOutings/theirs`), { poop: false, updatedAt: 6 }));
    await assertFails(deleteDoc(doc(db, `${H}/petOutings/theirs`)));
    await assertSucceeds(deleteDoc(doc(db, `${H}/petOutings/mine`)));
  });

  it('an admin or member changes and removes anyone\'s', async () => {
    await seed(`${H}/petOutings/o1`, outing(HELEN));
    await assertSucceeds(updateDoc(doc(as(BOB), `${H}/petOutings/o1`), { at: 7, updatedAt: 8 }));
    await assertSucceeds(deleteDoc(doc(as(ALICE), `${H}/petOutings/o1`)));
  });

  it('takes an extra outing, a walk with no bathroom details, and one from the assistant', async () => {
    const db = as(HELEN);
    await assertSucceeds(setDoc(doc(db, `${H}/petOutings/extra`), { petId: 'p1', at: 5, pee: true, poop: false, by: HELEN, createdAt: 5 }));
    await assertSucceeds(setDoc(doc(db, `${H}/petOutings/walk`), { petId: 'p1', at: 5, walkMin: 30, note: 'Round the park', by: HELEN, createdAt: 5 }));
    await assertSucceeds(setDoc(doc(db, `${H}/petOutings/via`), outing(HELEN, { via: 'assistant' })));
  });

  it('refuses what the app never writes', async () => {
    const db = as(ALICE);
    const bad = (extra: Record<string, unknown>) => assertFails(setDoc(doc(db, `${H}/petOutings/o1`), outing(ALICE, extra)));
    await bad({ petId: '' });
    await bad({ slot: '' });
    await bad({ slot: 'x'.repeat(41) });
    await bad({ at: '5' });
    await bad({ pee: 'yes' });
    await bad({ poop: 1 });
    await bad({ walkMin: 0 });
    await bad({ walkMin: 601 });
    await bad({ walkMin: 12.5 });
    await bad({ note: 'x'.repeat(201) });
    await bad({ via: 'portal' });
    await bad({ color: 'brown' });
    await assertFails(setDoc(doc(db, `${H}/petOutings/o2`), { petId: 'p1', pee: true, by: ALICE, createdAt: 5 }));
  });
});

describe('a Pet reminder about an outing', () => {
  const reminder = (by: string, source: unknown) => ({
    app: 'pet',
    title: 'Take Theo out · Breakfast',
    body: '',
    at: 1700000000000,
    url: 'https://huishouden-piekstra.web.app/pet/',
    recipients: [ALICE, BOB, HELEN],
    ref: 'pet:outings:p1',
    private: false,
    source,
    sent: false,
    createdAt: 1700000000000,
    by,
  });
  const source = { checks: [{ doc: 'petOutingPlans/p1', due: [{ field: 'on', in: [true] }] }, { doc: 'petOutings/out-p1-2023-11-14-meal-m1', absent: true }] };

  it('names the plan and the slot\'s outing as what it is about', async () => {
    await assertSucceeds(setDoc(doc(as(ALICE), `${H}/reminders/r1`), reminder(ALICE, source)));
    await assertSucceeds(setDoc(doc(as(HELEN), `${H}/reminders/r2`), reminder(HELEN, source)));
  });

  it('only from Pet', async () => {
    await assertFails(setDoc(doc(as(ALICE), `${H}/reminders/r3`), { ...reminder(ALICE, source), app: 'home' }));
  });
});
