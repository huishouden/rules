import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

// The calendar export (huishouden/calendar and @huishouden/pwa-kit/calendar-export): agenda items
// with a series and edits, each member's calendar settings, and the history of changes carried back
// from Google Calendar. One household with every role. All invented.
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const HELEN = 'helen@example.com';
const KIM = 'kim@example.com';
const MALLORY = 'mallory@example.com';
const MEMBERS = [ALICE, BOB, HELEN, KIM];
const ROLES = { [HELEN]: 'helper', [KIM]: 'kid' };
const H = 'households/h1';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-huishouden-calendar',
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
});

const as = (email: string) => env.authenticatedContext(email.split('@')[0], { email, email_verified: true }).firestore();

const series = { rule: { freq: 'week', every: 1, start: '2031-09-04' }, time: '07:00', minutes: 30, original: '2031-10-02', through: '2031-10-30' };
const edit = {
  reschedule: { ops: [{ col: 'homeEvents', id: 'bins', data: { exceptions: { '2031-10-02': { moved: { date: '$date', time: '$time' } } }, updatedAt: '$now' }, merge: true }], roles: ['admin', 'member'] },
  skip: { ops: [{ col: 'homeEvents', id: 'bins', data: { exceptions: { '2031-10-02': { skipped: true } }, updatedAt: '$now' }, merge: true }], roles: ['admin', 'member'] },
};
const item = (by: string, extra: Record<string, unknown> = {}) => ({
  app: 'home', ref: 'event:bins', kind: 'other', title: 'Garbage pickup', start: 1949000000000, allDay: false, url: 'https://huishouden-piekstra.web.app/home/', private: false, updatedAt: 5, by, ...extra,
});

describe('agenda items for calendars', () => {
  it('may carry a series and edits', async () => {
    await assertSucceeds(setDoc(doc(as(ALICE), `${H}/agenda/a1`), item(ALICE, { series, edit })));
    await assertSucceeds(setDoc(doc(as(ALICE), `${H}/personalAgenda/p1`), { ...item(ALICE, { series, edit }), private: true, audience: [ALICE, BOB] }));
  });

  it('refuses a series that is not one, and edits of unknown kinds', async () => {
    await assertFails(setDoc(doc(as(ALICE), `${H}/agenda/a2`), item(ALICE, { series: { ...series, extra: 1 } })));
    await assertFails(setDoc(doc(as(ALICE), `${H}/agenda/a3`), item(ALICE, { series: { ...series, original: 'soon' } })));
    await assertFails(setDoc(doc(as(ALICE), `${H}/agenda/a4`), item(ALICE, { series: 'weekly' })));
    await assertFails(setDoc(doc(as(ALICE), `${H}/agenda/a5`), item(ALICE, { edit: { pay: edit.skip } })));
    await assertFails(setDoc(doc(as(ALICE), `${H}/agenda/a6`), item(ALICE, { edit: 'move' })));
  });
});

const settings = (by: string, extra: Record<string, unknown> = {}) => ({ hiddenApps: ['pet'], todos: true, bills: false, healthDetail: false, done: true, updatedAt: 5, by, ...extra });

describe('calendarSettings', () => {
  it('each member reads and writes only their own', async () => {
    await assertSucceeds(setDoc(doc(as(BOB), `${H}/calendarSettings/${BOB}`), settings(BOB)));
    await assertSucceeds(getDoc(doc(as(BOB), `${H}/calendarSettings/${BOB}`)));
    await assertFails(getDoc(doc(as(ALICE), `${H}/calendarSettings/${BOB}`)));
    await assertFails(setDoc(doc(as(ALICE), `${H}/calendarSettings/${BOB}`), settings(ALICE)));
    await assertSucceeds(setDoc(doc(as(HELEN), `${H}/calendarSettings/${HELEN}`), settings(HELEN)));
    await assertSucceeds(setDoc(doc(as(KIM), `${H}/calendarSettings/${KIM}`), settings(KIM)));
    await assertFails(setDoc(doc(as(MALLORY), `${H}/calendarSettings/${MALLORY}`), settings(MALLORY)));
    await assertSucceeds(deleteDoc(doc(as(BOB), `${H}/calendarSettings/${BOB}`)));
  });

  it('holds only the settings: no tokens, no secrets, the right types', async () => {
    await assertFails(setDoc(doc(as(BOB), `${H}/calendarSettings/${BOB}`), settings(BOB, { feedToken: 'abc' })));
    await assertFails(setDoc(doc(as(BOB), `${H}/calendarSettings/${BOB}`), settings(BOB, { healthDetail: 'yes' })));
    await assertFails(setDoc(doc(as(BOB), `${H}/calendarSettings/${BOB}`), settings(BOB, { hiddenApps: 'pet' })));
    await assertFails(setDoc(doc(as(BOB), `${H}/calendarSettings/${BOB}`), settings(ALICE)));
  });
});

const change = (email: string, extra: Record<string, unknown> = {}) => ({
  email, source: 'google', app: 'home', ref: 'event:bins', title: 'Garbage pickup', change: 'moved', from: 'Thu 2 Oct, 07:00', to: 'Fri 3 Oct, 08:00',
  undo: [{ col: 'homeEvents', id: 'bins', data: { exceptions: {} }, merge: true }], at: 5, by: email, ...extra,
});

describe('calendarChanges', () => {
  it('a member records their own change, reads it, removes it, never edits it', async () => {
    await assertSucceeds(setDoc(doc(as(BOB), `${H}/calendarChanges/c1`), change(BOB)));
    await assertSucceeds(getDoc(doc(as(BOB), `${H}/calendarChanges/c1`)));
    await assertFails(updateDoc(doc(as(BOB), `${H}/calendarChanges/c1`), { title: 'x' }));
    await assertSucceeds(deleteDoc(doc(as(BOB), `${H}/calendarChanges/c1`)));
  });

  it('nobody else sees or writes one', async () => {
    await seed(`${H}/calendarChanges/c2`, change(BOB));
    await assertFails(getDoc(doc(as(ALICE), `${H}/calendarChanges/c2`)));
    await assertFails(deleteDoc(doc(as(ALICE), `${H}/calendarChanges/c2`)));
    await assertFails(setDoc(doc(as(ALICE), `${H}/calendarChanges/c3`), change(BOB)));
    await assertFails(setDoc(doc(as(MALLORY), `${H}/calendarChanges/c4`), change(MALLORY)));
  });

  it('only known changes from Google, a bounded undo', async () => {
    await assertFails(setDoc(doc(as(BOB), `${H}/calendarChanges/c5`), change(BOB, { change: 'paid' })));
    await assertFails(setDoc(doc(as(BOB), `${H}/calendarChanges/c6`), change(BOB, { source: 'outlook' })));
    await assertFails(setDoc(doc(as(BOB), `${H}/calendarChanges/c7`), change(BOB, { undo: Array.from({ length: 13 }, () => ({})) })));
    await assertFails(setDoc(doc(as(BOB), `${H}/calendarChanges/c8`), change(BOB, { token: 'x' })));
  });
});
