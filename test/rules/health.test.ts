import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore';

// Health: one household with every role. Nan is looked after by Bob (a member) and Helen (a
// helper); Alice is the admin. Carol is a member who doesn't care for Nan, Hank a helper who
// doesn't, Kim a kid listed as a carer by mistake, Mallory in no household. All invented.
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const CAROL = 'carol@example.com';
const HELEN = 'helen@example.com';
const HANK = 'hank@example.com';
const KIM = 'kim@example.com';
const MALLORY = 'mallory@example.com';
const MEMBERS = [ALICE, BOB, CAROL, HELEN, HANK, KIM];
const ROLES = { [HELEN]: 'helper', [HANK]: 'helper', [KIM]: 'kid' };

const P = 'households/h1/healthPeople/nan';
const URL = 'https://huishouden-piekstra.web.app/health/';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-huishouden-health',
    firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') },
  });
});
afterAll(async () => {
  await env.cleanup();
});

const person = (over: Record<string, unknown> = {}) => ({
  name: 'Nan', carers: [BOB, HELEN, KIM], readers: [BOB, HELEN, KIM], allergies: 'Penicillin', createdAt: 1, by: ALICE, ...over,
});
const med = (by: string, over: Record<string, unknown> = {}) => ({
  personId: 'nan', name: 'Lisinopril', strength: '10 mg', dose: '1 tablet', doseAmount: 1, doseUnit: 'tablet', asNeeded: false, times: ['08:00', '20:00'],
  everyDays: 1, withFood: true, startDate: '2031-01-05', refills: 2, supply: 30, supplyAt: 1, escalateMinutes: 30, remind: true, createdAt: 1, by, ...over,
});
const dose = (by: string, over: Record<string, unknown> = {}) => ({ personId: 'nan', medId: 'm1', slot: '2031-01-05T08:00', at: 5, status: 'given', by, createdAt: 5, ...over });

async function seed(path: string, data: Record<string, unknown>) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
}

beforeEach(async () => {
  await env.clearFirestore();
  await seed('households/h1', { name: 'Home', members: MEMBERS, joined: MEMBERS, roles: ROLES, createdAt: 1 });
  await seed(P, person());
  await seed(`${P}/meds/m1`, med(ALICE));
  await seed(`${P}/doses/d1`, dose(HELEN));
  await seed(`${P}/photo/avatar`, { data: 'data:image/webp;base64,AAAA', updatedAt: 1, by: ALICE });
});

const as = (email: string) => env.authenticatedContext(email.split('@')[0], { email, email_verified: true }).firestore();
const ok = (allowed: boolean, p: Promise<unknown>) => (allowed ? assertSucceeds(p) : assertFails(p));

describe('health: reading a person and everything under them', () => {
  const cases: [string, boolean][] = [
    [ALICE, true], [BOB, true], [HELEN, true], [CAROL, false], [HANK, false], [KIM, false], [MALLORY, false],
  ];
  for (const [who, allowed] of cases) {
    it(`${who} ${allowed ? 'reads' : 'does not read'} Nan, her medicines, doses and photo`, async () => {
      const db = as(who);
      await ok(allowed, getDoc(doc(db, P)));
      await ok(allowed, getDoc(doc(db, `${P}/meds/m1`)));
      await ok(allowed, getDoc(doc(db, `${P}/doses/d1`)));
      await ok(allowed, getDoc(doc(db, `${P}/photo/avatar`)));
      await ok(allowed, getDocs(collection(db, `${P}/meds`)));
      await ok(allowed, getDocs(collection(db, `${P}/doses`)));
    });
  }

  it('lists people: admins all of them, others only with readers array-contains themselves', async () => {
    await assertSucceeds(getDocs(collection(as(ALICE), 'households/h1/healthPeople')));
    await assertFails(getDocs(collection(as(BOB), 'households/h1/healthPeople')));
    await assertSucceeds(getDocs(query(collection(as(BOB), 'households/h1/healthPeople'), where('readers', 'array-contains', BOB))));
    await assertSucceeds(getDocs(query(collection(as(HELEN), 'households/h1/healthPeople'), where('readers', 'array-contains', HELEN))));
    await assertSucceeds(getDocs(query(collection(as(CAROL), 'households/h1/healthPeople'), where('readers', 'array-contains', CAROL))));
    // A kid named as a reader still reads nothing.
    await assertFails(getDocs(query(collection(as(KIM), 'households/h1/healthPeople'), where('readers', 'array-contains', KIM))));
    await assertFails(getDocs(query(collection(as(MALLORY), 'households/h1/healthPeople'), where('readers', 'array-contains', MALLORY))));
  });
});

describe('health: keeping people and medicines', () => {
  it('admins and member carers add and change a person; others do not', async () => {
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/healthPeople/p2'), person({ by: ALICE, carers: [], readers: [] })));
    await assertSucceeds(setDoc(doc(as(BOB), 'households/h1/healthPeople/p3'), person({ by: BOB, carers: [BOB], readers: [BOB] })));
    // A member must stay among the readers of a person they add.
    await assertFails(setDoc(doc(as(CAROL), 'households/h1/healthPeople/p4'), person({ by: CAROL, carers: [BOB], readers: [BOB] })));
    await assertSucceeds(updateDoc(doc(as(BOB), P), { notes: 'Takes them with breakfast', updatedAt: 2, by: BOB }));
    await assertFails(updateDoc(doc(as(CAROL), P), { notes: 'x', updatedAt: 2, by: CAROL, readers: [BOB, HELEN, KIM, CAROL] }));
    await assertFails(updateDoc(doc(as(HELEN), P), { notes: 'x', updatedAt: 2, by: HELEN }));
    await assertFails(updateDoc(doc(as(KIM), P), { notes: 'x', updatedAt: 2, by: KIM }));
    await assertFails(deleteDoc(doc(as(HELEN), P)));
    await assertFails(deleteDoc(doc(as(CAROL), P)));
  });

  it('checks the shape: carers among readers, the person among readers, known fields', async () => {
    const db = as(ALICE);
    await assertFails(setDoc(doc(db, 'households/h1/healthPeople/x'), person({ readers: [BOB] })));
    await assertFails(setDoc(doc(db, 'households/h1/healthPeople/x'), person({ email: 'nan@example.com' })));
    await assertSucceeds(setDoc(doc(db, 'households/h1/healthPeople/x'), person({ email: 'nan@example.com', readers: [BOB, HELEN, KIM, 'nan@example.com'] })));
    await assertFails(setDoc(doc(db, 'households/h1/healthPeople/x'), person({ name: '' })));
    await assertFails(setDoc(doc(db, 'households/h1/healthPeople/x'), person({ ssn: '1' })));
    await assertFails(setDoc(doc(db, 'households/h1/healthPeople/x'), person({ by: BOB })));
  });

  it('medicines: admins and member carers write; helper carers only mark a refill ordered', async () => {
    await assertSucceeds(setDoc(doc(as(BOB), `${P}/meds/m2`), med(BOB, { asNeeded: true, times: [], minHours: 4, maxPerDay: 4 })));
    await assertSucceeds(setDoc(doc(as(ALICE), `${P}/meds/m3`), med(ALICE, { rule: { freq: 'week', every: 1, start: '2031-01-06', days: [1] } })));
    await assertFails(setDoc(doc(as(HELEN), `${P}/meds/m2`), med(HELEN)));
    await assertFails(setDoc(doc(as(CAROL), `${P}/meds/m2`), med(CAROL)));
    await assertFails(setDoc(doc(as(KIM), `${P}/meds/m2`), med(KIM)));
    await assertSucceeds(updateDoc(doc(as(HELEN), `${P}/meds/m1`), { refillOrderedAt: 9, updatedAt: 9 }));
    await assertFails(updateDoc(doc(as(HELEN), `${P}/meds/m1`), { supply: 90 }));
    await assertFails(updateDoc(doc(as(CAROL), `${P}/meds/m1`), { refillOrderedAt: 9 }));
    await assertFails(deleteDoc(doc(as(HELEN), `${P}/meds/m1`)));
    await assertSucceeds(deleteDoc(doc(as(BOB), `${P}/meds/m1`)));
  });

  it('medicines: times, numbers and dates are checked', async () => {
    const db = as(ALICE);
    await assertFails(setDoc(doc(db, `${P}/meds/x`), med(ALICE, { times: ['8am'] })));
    await assertFails(setDoc(doc(db, `${P}/meds/x`), med(ALICE, { times: ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00'] })));
    await assertFails(setDoc(doc(db, `${P}/meds/x`), med(ALICE, { escalateMinutes: 500 })));
    await assertFails(setDoc(doc(db, `${P}/meds/x`), med(ALICE, { startDate: 'soon' })));
    await assertFails(setDoc(doc(db, `${P}/meds/x`), med(ALICE, { doseAmount: 0 })));
    await assertFails(setDoc(doc(db, `${P}/meds/x`), med(ALICE, { remind: 'yes' })));
    // personId must be the person in the path.
    await assertFails(setDoc(doc(db, `${P}/meds/x`), med(ALICE, { personId: 'someone' })));
    const { personId: _p, ...noPerson } = med(ALICE);
    await assertFails(setDoc(doc(db, `${P}/meds/x`), noPerson));
  });

  it('photo: only `avatar`, by admins and member carers', async () => {
    const photo = (by: string) => ({ data: 'data:image/jpeg;base64,BBBB', updatedAt: 2, by });
    await assertSucceeds(setDoc(doc(as(BOB), `${P}/photo/avatar`), photo(BOB)));
    await assertFails(setDoc(doc(as(BOB), `${P}/photo/other`), photo(BOB)));
    await assertFails(setDoc(doc(as(HELEN), `${P}/photo/avatar`), photo(HELEN)));
  });
});

describe('health: recording doses', () => {
  it('carers record doses in their own name, helpers included; others never', async () => {
    await assertSucceeds(setDoc(doc(as(HELEN), `${P}/doses/d2`), dose(HELEN)));
    await assertSucceeds(setDoc(doc(as(BOB), `${P}/doses/d3`), dose(BOB, { status: 'skipped', note: 'Asleep' })));
    const { slot: _s, ...asNeeded } = dose(ALICE);
    await assertSucceeds(setDoc(doc(as(ALICE), `${P}/doses/d4`), asNeeded));
    await assertFails(setDoc(doc(as(HELEN), `${P}/doses/d5`), dose(BOB)));
    await assertFails(setDoc(doc(as(HANK), `${P}/doses/d5`), dose(HANK)));
    await assertFails(setDoc(doc(as(CAROL), `${P}/doses/d5`), dose(CAROL)));
    await assertFails(setDoc(doc(as(KIM), `${P}/doses/d5`), dose(KIM)));
    await assertFails(setDoc(doc(as(MALLORY), `${P}/doses/d5`), dose(MALLORY)));
    await assertFails(setDoc(doc(as(BOB), `${P}/doses/d6`), dose(BOB, { status: 'maybe' })));
    await assertFails(setDoc(doc(as(BOB), `${P}/doses/d6`), dose(BOB, { slot: 'tomorrow' })));
    await assertFails(setDoc(doc(as(BOB), `${P}/doses/d6`), dose(BOB, { personId: 'someone' })));
    const { personId: _p, ...noPerson } = dose(BOB);
    await assertFails(setDoc(doc(as(BOB), `${P}/doses/d6`), noPerson));
  });

  it('a helper changes and removes only their own; keepers any, and `by` stays', async () => {
    await seed(`${P}/doses/b1`, dose(BOB));
    await assertFails(updateDoc(doc(as(HELEN), `${P}/doses/b1`), { at: 6 }));
    await assertFails(deleteDoc(doc(as(HELEN), `${P}/doses/b1`)));
    await assertSucceeds(updateDoc(doc(as(HELEN), `${P}/doses/d1`), { at: 6 }));
    await assertSucceeds(updateDoc(doc(as(BOB), `${P}/doses/d1`), { at: 7 }));
    await assertFails(updateDoc(doc(as(BOB), `${P}/doses/d1`), { by: BOB }));
    await assertSucceeds(deleteDoc(doc(as(HELEN), `${P}/doses/d1`)));
    await assertSucceeds(deleteDoc(doc(as(BOB), `${P}/doses/b1`)));
  });
});

const visit = (by: string, over: Record<string, unknown> = {}) => ({
  personId: 'nan', kind: 'dentist', title: 'Cleaning', at: 1_936_000_000_000, contactId: 'c1', location: '12 Example Street', prep: ['Fasting from midnight'],
  medList: true, remindBefore: [1440, 120], followUp: { every: 3, unit: 'month' }, createdAt: 1, by, ...over,
});
const V = `${P}/visits`;

describe('health: visits', () => {
  beforeEach(async () => {
    await seed(`${V}/v1`, visit(BOB));
    await seed(`${V}/h1`, visit(HELEN));
    await seed(`${P}/visitNotes/v1`, { personId: 'nan', text: 'Cavity on the left; see again in 3 months.', updatedAt: 1, by: BOB });
  });

  it("everyone who reads the person reads the visits; only keepers read a visit's notes", async () => {
    for (const [who, allowed] of [[ALICE, true], [BOB, true], [HELEN, true], [CAROL, false], [HANK, false], [KIM, false], [MALLORY, false]] as const) {
      await ok(allowed, getDoc(doc(as(who), `${V}/v1`)));
      await ok(allowed, getDocs(collection(as(who), V)));
    }
    for (const [who, allowed] of [[ALICE, true], [BOB, true], [HELEN, false], [CAROL, false], [KIM, false]] as const) {
      await ok(allowed, getDoc(doc(as(who), `${P}/visitNotes/v1`)));
      await ok(allowed, getDocs(collection(as(who), `${P}/visitNotes`)));
    }
  });

  it('keepers and helper carers add visits in their own name; nobody else, and only the fields Health writes', async () => {
    await assertSucceeds(setDoc(doc(as(ALICE), `${V}/a`), visit(ALICE)));
    await assertSucceeds(setDoc(doc(as(BOB), `${V}/b`), visit(BOB, { allDay: true, minutes: 30, link: 'https://video.example.com/r/1', followUpOf: 'v1', calendarEventId: 'evt_1', calendarLink: 'https://calendar.example.com/e/1' })));
    await assertSucceeds(setDoc(doc(as(HELEN), `${V}/c`), visit(HELEN)));
    await assertSucceeds(setDoc(doc(as(BOB), `${V}/d`), visit(BOB, { via: 'assistant' })));
    const { prep: _p, medList: _m, followUp: _f, contactId: _c, location: _l, title: _t, ...bare } = visit(BOB, { kind: 'other', remindBefore: [] });
    await assertSucceeds(setDoc(doc(as(BOB), `${V}/e`), bare));
    await assertFails(setDoc(doc(as(HELEN), `${V}/x`), visit(BOB)));
    for (const who of [CAROL, HANK, KIM, MALLORY]) await assertFails(setDoc(doc(as(who), `${V}/x`), visit(who)));
    for (const over of [
      { kind: 'surgery' },
      { title: '' },
      { title: 'x'.repeat(121) },
      { at: 'tomorrow' },
      { personId: 'someone' },
      { link: 'http://video.example.com' },
      { minutes: 2 },
      { remindBefore: [1440, 120, 60, 30, 10] },
      { remindBefore: [-5] },
      { remindBefore: ['1440'] },
      { followUp: { every: 3, unit: 'year' } },
      { followUp: { every: 30, unit: 'month' } },
      { prep: 'Fasting' },
      { prep: ['x'.repeat(500)] },
      { status: 'cancelled' },
      { via: 'email' },
      { notes: 'Notes go in visitNotes' },
      { status: 'attended', markedAt: 2, markedBy: ALICE },
      { contactId: ['c1'] },
      { title: 7 },
    ]) {
      await assertFails(setDoc(doc(as(BOB), `${V}/x`), visit(BOB, over)));
    }
    const { personId: _pid, ...noPerson } = visit(BOB);
    await assertFails(setDoc(doc(as(BOB), `${V}/x`), noPerson));
  });

  it('a helper changes and removes only their own; keepers any, and `by` stays', async () => {
    await assertSucceeds(updateDoc(doc(as(HELEN), `${V}/h1`), { title: 'Cleaning and check', updatedAt: 2 }));
    await assertFails(updateDoc(doc(as(HELEN), `${V}/v1`), { title: 'Moved', updatedAt: 2 }));
    await assertFails(updateDoc(doc(as(HELEN), `${V}/v1`), { at: 1_936_100_000_000, updatedAt: 2 }));
    await assertSucceeds(updateDoc(doc(as(BOB), `${V}/h1`), { at: 1_936_100_000_000, updatedAt: 2 }));
    await assertSucceeds(updateDoc(doc(as(ALICE), `${V}/v1`), { title: 'Moved', updatedAt: 3 }));
    // Health writes the whole document on every save: every field at once stays within the rules' limits.
    const full = { allDay: false, minutes: 90, link: 'https://video.example.com/r/1', followUpOf: 'v0', followUpDoneAt: 4, status: 'attended', markedAt: 4, markedBy: BOB, calendarEventId: 'evt_1', calendarLink: 'https://calendar.example.com/e/1', via: 'assistant', updatedAt: 4 };
    await assertSucceeds(setDoc(doc(as(BOB), `${V}/h1`), visit(HELEN, { ...full, remindBefore: [10080, 1440, 120, 0], prep: ['Fasting from midnight', 'Bring the insurance card', 'Arrive 15 minutes early'] })));
    await assertSucceeds(setDoc(doc(as(HELEN), `${V}/h1`), visit(HELEN, { ...full, markedBy: HELEN, remindBefore: [10080, 1440, 120, 0], updatedAt: 5 })));
    await assertFails(updateDoc(doc(as(BOB), `${V}/h1`), { by: BOB }));
    await assertFails(updateDoc(doc(as(BOB), `${V}/h1`), { title: 'Moved', status: 'attended', markedAt: 4, markedBy: ALICE, updatedAt: 4 }));
    await assertSucceeds(updateDoc(doc(as(BOB), `${V}/h1`), { title: 'Moved', status: 'attended', markedAt: 4, markedBy: BOB, updatedAt: 4 }));
    await assertSucceeds(updateDoc(doc(as(ALICE), `${V}/h1`), { title: 'Moved again', updatedAt: 5 }));
    await assertFails(updateDoc(doc(as(CAROL), `${V}/v1`), { title: 'Nope' }));
    await assertFails(deleteDoc(doc(as(HELEN), `${V}/v1`)));
    await assertSucceeds(deleteDoc(doc(as(HELEN), `${V}/h1`)));
    await assertSucceeds(deleteDoc(doc(as(BOB), `${V}/v1`)));
  });

  it('any reader marks a visit Attended or Missed as themself, undoes it, and answers the follow-up', async () => {
    await assertSucceeds(updateDoc(doc(as(HELEN), `${V}/v1`), { status: 'attended', markedAt: 5, markedBy: HELEN, updatedAt: 5 }));
    const unmarked = visit(BOB, { updatedAt: 6 });
    await assertSucceeds(setDoc(doc(as(HELEN), `${V}/v1`), unmarked));
    await assertFails(updateDoc(doc(as(HELEN), `${V}/v1`), { status: 'missed', markedAt: 7, markedBy: BOB, updatedAt: 7 }));
    await assertFails(updateDoc(doc(as(HELEN), `${V}/v1`), { status: 'cancelled', markedAt: 7, markedBy: HELEN, updatedAt: 7 }));
    await assertSucceeds(updateDoc(doc(as(HELEN), `${V}/v1`), { status: 'missed', markedAt: 7, markedBy: HELEN, updatedAt: 7 }));
    await assertSucceeds(updateDoc(doc(as(HELEN), `${V}/v1`), { followUpDoneAt: 8, updatedAt: 8 }));
    await assertFails(updateDoc(doc(as(CAROL), `${V}/v1`), { followUpDoneAt: 9, updatedAt: 9 }));
    await assertFails(updateDoc(doc(as(KIM), `${V}/v1`), { status: 'attended', markedAt: 9, markedBy: KIM, updatedAt: 9 }));
  });

  it('keepers keep the notes in their own name; helpers never', async () => {
    const note = (by: string, over: Record<string, unknown> = {}) => ({ personId: 'nan', text: 'Bring the X-ray next time.', updatedAt: 2, by, ...over });
    await assertSucceeds(setDoc(doc(as(BOB), `${P}/visitNotes/v1`), note(BOB)));
    await assertSucceeds(setDoc(doc(as(ALICE), `${P}/visitNotes/h1`), note(ALICE, { via: 'assistant' })));
    await assertFails(setDoc(doc(as(HELEN), `${P}/visitNotes/h1`), note(HELEN)));
    await assertFails(setDoc(doc(as(CAROL), `${P}/visitNotes/v1`), note(CAROL)));
    await assertFails(setDoc(doc(as(BOB), `${P}/visitNotes/v1`), note(ALICE)));
    await assertFails(setDoc(doc(as(BOB), `${P}/visitNotes/v1`), note(BOB, { text: 'x'.repeat(1001) })));
    await assertFails(setDoc(doc(as(BOB), `${P}/visitNotes/v1`), note(BOB, { personId: 'someone' })));
    await assertFails(setDoc(doc(as(BOB), `${P}/visitNotes/v1`), note(BOB, { title: 'x' })));
    await assertFails(deleteDoc(doc(as(HELEN), `${P}/visitNotes/v1`)));
    await assertSucceeds(deleteDoc(doc(as(BOB), `${P}/visitNotes/v1`)));
  });
});

describe('for named people only: personal agenda, to-dos and reminders', () => {
  const agenda = (by: string, audience: string[]) => ({
    app: 'health', ref: 'dose:nan:08:00', kind: 'medicine', title: 'Medicine for Nan', start: 10, allDay: false, url: URL, status: 'upcoming', private: true, audience, updatedAt: 1, by,
  });
  const todo = (by: string, audience: string[]) => ({
    app: 'health', ref: 'missed:nan', title: 'Missed 8:00 AM medicine for Nan', createdAt: 1, url: URL, status: 'open', private: true, audience, updatedAt: 1, by,
    done: { label: 'Given', ops: [{ col: 'healthPeople/nan/doses', id: 'x', data: { medId: 'm1' } }], roles: ['admin'], emails: [BOB, HELEN] },
  });
  const reminder = (by: string, audience: string[], over: Record<string, unknown> = {}) => ({
    app: 'health', title: 'Medicine for Nan', body: '8:00 AM: Lisinopril 10 mg', at: 10, url: URL, recipients: [BOB], ref: 'health:dose:nan', private: true, audience, sent: false, createdAt: 1, by, ...over,
  });
  const AUD = [ALICE, BOB, HELEN];

  for (const [col, make] of [['personalAgenda', agenda], ['personalTodos', todo], ['personalReminders', reminder]] as const) {
    it(`${col}: only the audience reads, writes and removes, the writer among them`, async () => {
      const id = col === 'personalTodos' ? 'health:missed_nan' : 'i1';
      const path = `households/h1/${col}/${id}`;
      await assertSucceeds(setDoc(doc(as(HELEN), path), make(HELEN, AUD)));
      await assertSucceeds(getDoc(doc(as(BOB), path)));
      await assertSucceeds(getDocs(query(collection(as(BOB), `households/h1/${col}`), where('audience', 'array-contains', BOB))));
      await assertSucceeds(getDocs(query(collection(as(CAROL), `households/h1/${col}`), where('audience', 'array-contains', CAROL))));
      await assertFails(getDocs(collection(as(BOB), `households/h1/${col}`)));
      await assertFails(getDoc(doc(as(CAROL), path)));
      await assertFails(getDoc(doc(as(MALLORY), path)));
      await assertFails(setDoc(doc(as(CAROL), path), make(CAROL, [...AUD, CAROL])));
      await assertFails(setDoc(doc(as(CAROL), `households/h1/${col}/${col === 'personalTodos' ? 'health:other' : 'i2'}`), make(CAROL, AUD)));
      await assertFails(setDoc(doc(as(BOB), `households/h1/${col}/${col === 'personalTodos' ? 'health:other' : 'i2'}`), make(HELEN, AUD)));
      await assertFails(setDoc(doc(as(KIM), `households/h1/${col}/${col === 'personalTodos' ? 'health:other' : 'i2'}`), make(KIM, [KIM])));
      await assertFails(setDoc(doc(as(MALLORY), `households/h1/${col}/${col === 'personalTodos' ? 'health:other' : 'i2'}`), make(MALLORY, [MALLORY])));
      await assertFails(setDoc(doc(as(BOB), path), { ...make(BOB, AUD), url: 'https://example.com/' }));
      await assertFails(deleteDoc(doc(as(CAROL), path)));
      await assertSucceeds(deleteDoc(doc(as(BOB), path)));
    });
  }

  it('personalReminders: recipients are a list, and a sent one is never armed again', async () => {
    const path = 'households/h1/personalReminders/r1';
    await assertFails(setDoc(doc(as(BOB), path), reminder(BOB, AUD, { recipients: 'all' })));
    await seed(path, reminder(BOB, AUD, { sent: true, sentAt: 11 }));
    await assertFails(setDoc(doc(as(BOB), path), reminder(BOB, AUD)));
    await assertSucceeds(setDoc(doc(as(BOB), path), reminder(BOB, AUD, { sent: true, sentAt: 11, title: 'Medicine for Nan (late)' })));
  });

  it('personalTodos: the id is the app and ref', async () => {
    await assertFails(setDoc(doc(as(BOB), 'households/h1/personalTodos/pet:x'), todo(BOB, AUD)));
  });
});
