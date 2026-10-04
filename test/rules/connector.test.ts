import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';

// What huishouden/connector writes as a member from their AI assistant: records marked
// `via: 'assistant'`, the member's language and time zone, their connections and the audit log.
// One household with every role; Nan is looked after by Bob and Helen. All invented.
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const CAROL = 'carol@example.com';
const HELEN = 'helen@example.com';
const KIM = 'kim@example.com';
const MALLORY = 'mallory@example.com';
const MEMBERS = [ALICE, BOB, CAROL, HELEN, KIM];
const ROLES = { [HELEN]: 'helper', [KIM]: 'kid' };
const H = 'households/h1';
const P = `${H}/healthPeople/nan`;

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-huishouden-connector',
    firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') },
  });
});
afterAll(async () => {
  await env.cleanup();
});

async function seed(path: string, data: Record<string, unknown>) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
}

beforeEach(async () => {
  await env.clearFirestore();
  await seed(H, { name: 'Home', members: MEMBERS, joined: MEMBERS, roles: ROLES, createdAt: 1 });
  await seed(`${H}/petMedCourses/c1`, { petId: 'p1', name: 'Drops', dose: '1 drop', timesPerDay: 1, times: ['08:00'], startDate: '2031-01-05', days: 7, withFood: false, createdAt: 1, by: ALICE });
  await seed(P, { name: 'Nan', carers: [BOB, HELEN], readers: [BOB, HELEN], createdAt: 1, by: ALICE });
  await seed(`${H}/connections/g1`, { email: BOB, client: 'Claude', createdAt: 1, by: BOB });
});

const as = (email: string) => env.authenticatedContext(email.split('@')[0], { email, email_verified: true }).firestore();

// One record per collection the connector creates, as `who` writes it.
const records = (who: string): [string, Record<string, unknown>][] => [
  [`${H}/items/i1`, { listId: 'groceries', name: 'Milk', category: 'Dairy & Eggs', quantity: '1', notes: '', addedBy: 'Bob', by: who, completed: false, urgency: 'Standard', position: 5, createdAt: 5, updatedAt: 5, completedAt: null }],
  [`${H}/petFeedings/f1`, { petId: 'p1', mealId: 'm1', at: 5, by: who, createdAt: 5 }],
  [`${H}/petDoses/d1`, { petId: 'p1', reminderId: 'r1', title: 'Heartworm', at: 5, by: who, createdAt: 5 }],
  [`${H}/petMedDoses/md1`, { petId: 'p1', courseId: 'c1', slot: 0, at: 5, by: who, createdAt: 5 }],
  [`${H}/petAppointments/a1`, { petIds: ['p1'], kind: 'vet', title: 'Checkup', at: 5, private: false, createdAt: 5, by: who }],
  [`${H}/babyAppointments/a1`, { title: 'Checkup', at: 5, private: false, createdAt: 5, by: who }],
  [`${H}/carAppointments/a1`, { title: 'Oil change', at: 5, private: false, createdAt: 5, by: who }],
  [`${H}/homeEvents/e1`, { title: 'Trash', kind: 'trash', rule: { freq: 'week', every: 1, start: '2031-01-06', days: [1] }, createdAt: 5, by: who }],
  [`${H}/homeServiceLog/s1`, { date: '2031-01-09', title: 'Gutter cleaning', createdAt: 5, by: who }],
  [`${H}/contacts/c1`, { name: 'Dr. Example', role: 'Doctor', apps: ['health'], private: false, createdAt: 5, by: who }],
];

describe('via: assistant', () => {
  for (const [path, data] of records(BOB)) {
    const name = path.split('/')[2];
    it(`${name}: a member's record may say it came from their assistant, and nothing else`, async () => {
      await assertSucceeds(setDoc(doc(as(BOB), path), { ...data, via: 'assistant' }));
      await assertFails(setDoc(doc(as(BOB), `${path}x`), { ...data, via: 'email' }));
      await assertFails(setDoc(doc(as(BOB), `${path}y`), { ...data, via: true }));
    });
  }

  it("a helper's assistant creates in their own name, as the helper would", async () => {
    await assertSucceeds(setDoc(doc(as(HELEN), `${H}/petFeedings/f2`), { petId: 'p1', at: 5, by: HELEN, createdAt: 5, via: 'assistant' }));
    await assertFails(setDoc(doc(as(HELEN), `${H}/petFeedings/f3`), { petId: 'p1', at: 5, by: BOB, createdAt: 5, via: 'assistant' }));
    await assertFails(setDoc(doc(as(KIM), `${H}/petDoses/d2`), { petId: 'p1', reminderId: 'r1', title: 'Heartworm', at: 5, by: KIM, createdAt: 5, via: 'assistant' }));
  });

  const med = (by: string, over: Record<string, unknown> = {}) => ({
    personId: 'nan', name: 'Examplamine', strength: '10 mg', dose: '1 tablet', asNeeded: false, times: ['08:00'], everyDays: 1, startDate: '2031-01-05',
    escalateMinutes: 30, remind: true, createdAt: 5, by, ...over,
  });
  const dose = (by: string, over: Record<string, unknown> = {}) => ({ personId: 'nan', medId: 'm1', slot: '2031-01-05T08:00', at: 5, status: 'given', by, createdAt: 5, ...over });

  it('health: a carer adds a medicine and logs a dose from the assistant; a non-carer cannot', async () => {
    await assertSucceeds(setDoc(doc(as(BOB), `${P}/meds/m1`), med(BOB, { via: 'assistant' })));
    await assertFails(setDoc(doc(as(BOB), `${P}/meds/m2`), med(BOB, { via: 'robot' })));
    await assertSucceeds(setDoc(doc(as(HELEN), `${P}/doses/d1`), dose(HELEN, { via: 'assistant' })));
    await assertFails(setDoc(doc(as(HELEN), `${P}/doses/d2`), dose(HELEN, { via: 'robot' })));
    await assertFails(setDoc(doc(as(CAROL), `${P}/meds/m3`), med(CAROL, { via: 'assistant' })));
    await assertFails(setDoc(doc(as(CAROL), `${P}/doses/d3`), dose(CAROL, { via: 'assistant' })));
    await assertFails(setDoc(doc(as(KIM), `${P}/doses/d4`), dose(KIM, { via: 'assistant' })));
  });
});

describe('profiles: language and time zone', () => {
  const path = `${H}/profiles/${BOB}`;
  it('a member stores their own language and time zone', async () => {
    await assertSucceeds(setDoc(doc(as(BOB), path), { name: 'Bob', lang: 'nl', timeZone: 'Europe/Amsterdam', updatedAt: 5 }));
    await assertSucceeds(setDoc(doc(as(BOB), path), { lang: 'es', timeZone: 'America/Argentina/Buenos_Aires', updatedAt: 6 }));
    await assertSucceeds(setDoc(doc(as(BOB), path), { timeZone: 'UTC', updatedAt: 7 }));
  });
  it('only the three languages, a time-zone name, and only their own', async () => {
    await assertFails(setDoc(doc(as(BOB), path), { lang: 'fr', updatedAt: 5 }));
    await assertFails(setDoc(doc(as(BOB), path), { timeZone: 'Europe/Amsterdam; drop', updatedAt: 5 }));
    await assertFails(setDoc(doc(as(BOB), path), { timeZone: 5, updatedAt: 5 }));
    await assertFails(setDoc(doc(as(ALICE), path), { lang: 'en', updatedAt: 5 }));
  });
});

describe('connections and their audit log', () => {
  const C = `${H}/connections`;
  const entry = (by: string, over: Record<string, unknown> = {}) => ({ tool: 'groceries_add', kind: 'write', ok: true, app: 'groceries', ref: 'items/i1', at: 5, by, ...over });

  it('only the member reads, lists and removes their own connections', async () => {
    await assertSucceeds(getDoc(doc(as(BOB), `${C}/g1`)));
    for (const who of [ALICE, CAROL, HELEN, MALLORY]) await assertFails(getDoc(doc(as(who), `${C}/g1`)));
    await assertFails(deleteDoc(doc(as(ALICE), `${C}/g1`)));
    await assertSucceeds(deleteDoc(doc(as(BOB), `${C}/g1`)));
  });

  it('a member records a connection of their own, never someone else\'s', async () => {
    await assertSucceeds(setDoc(doc(as(CAROL), `${C}/g2`), { email: CAROL, client: 'ChatGPT', clientUri: 'https://chatgpt.com', createdAt: 5, by: CAROL }));
    await assertFails(setDoc(doc(as(CAROL), `${C}/g3`), { email: BOB, client: 'ChatGPT', createdAt: 5, by: CAROL }));
    await assertFails(setDoc(doc(as(CAROL), `${C}/g4`), { email: CAROL, client: 'ChatGPT', clientUri: 'javascript:alert(1)', createdAt: 5, by: CAROL }));
    await assertFails(setDoc(doc(as(CAROL), `${C}/g5`), { email: CAROL, client: 'ChatGPT', createdAt: 5, by: CAROL, token: 'x' }));
    await assertFails(setDoc(doc(as(MALLORY), `${C}/g6`), { email: MALLORY, client: 'Claude', createdAt: 5, by: MALLORY }));
    await assertFails(setDoc(doc(as(CAROL), `${C}/g1`), { email: CAROL, client: 'Claude', createdAt: 5, by: CAROL }));
  });

  it('the member marks it used; createdAt and the owner stay', async () => {
    await assertSucceeds(updateDoc(doc(as(BOB), `${C}/g1`), { lastUsedAt: 9 }));
    await assertFails(updateDoc(doc(as(BOB), `${C}/g1`), { createdAt: 9 }));
    await assertFails(updateDoc(doc(as(ALICE), `${C}/g1`), { lastUsedAt: 9 }));
  });

  it('audit entries: written and read only by the connection\'s member, never changed', async () => {
    await assertSucceeds(setDoc(doc(as(BOB), `${C}/g1/audit/a1`), entry(BOB)));
    await assertSucceeds(setDoc(doc(as(BOB), `${C}/g1/audit/a2`), { tool: 'today', kind: 'read', ok: true, at: 5, by: BOB }));
    await assertSucceeds(getDocs(collection(as(BOB), `${C}/g1/audit`)));
    await assertFails(getDocs(collection(as(ALICE), `${C}/g1/audit`)));
    await assertFails(setDoc(doc(as(ALICE), `${C}/g1/audit/a3`), entry(ALICE)));
    await assertFails(setDoc(doc(as(BOB), `${C}/g1/audit/a4`), entry(BOB, { kind: 'delete' })));
    await assertFails(setDoc(doc(as(BOB), `${C}/g1/audit/a5`), entry(BOB, { medicine: 'Examplamine' })));
    await assertFails(setDoc(doc(as(BOB), `${C}/missing/audit/a6`), entry(BOB)));
    await assertFails(updateDoc(doc(as(BOB), `${C}/g1/audit/a1`), { ok: false }));
    await assertSucceeds(deleteDoc(doc(as(BOB), `${C}/g1/audit/a1`)));
  });
});
