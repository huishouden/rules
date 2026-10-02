import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { arrayUnion, collection, collectionGroup, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const MALLORY = 'mallory@example.com';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-huishouden-rules',
    firestore: {
      // Host and port come from FIRESTORE_EMULATOR_HOST, which `firebase emulators:exec` sets.
      rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8'),
    },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'households/h1'), { name: 'Home', members: [ALICE, BOB], createdAt: 1 });
    await setDoc(doc(db, 'households/h1/items/i1'), { name: 'Milk', listId: 'groceries', completed: false });
  });
});

function as(email: string, verified = true) {
  return env.authenticatedContext(email.split('@')[0], { email, email_verified: verified }).firestore();
}

describe('households', () => {
  it('lets members find their household with an array-contains query', async () => {
    await assertSucceeds(getDocs(query(collection(as(ALICE), 'households'), where('members', 'array-contains', ALICE))));
  });

  it('hides a household from non-members', async () => {
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1')));
  });

  it('rejects unverified emails', async () => {
    await assertFails(getDoc(doc(as(ALICE, false), 'households/h1')));
  });

  it('rejects signed-out users', async () => {
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'households/h1')));
  });

  it('allows creating a household that contains only yourself', async () => {
    await assertSucceeds(setDoc(doc(as(MALLORY), 'households/h2'), { name: 'Mine', members: [MALLORY], createdAt: Date.now() }));
  });

  it('allows creating a household and its default lists in one batch', async () => {
    const db = as(MALLORY);
    const batch = writeBatch(db);
    batch.set(doc(db, 'households/h3'), { name: 'Mine', members: [MALLORY], createdAt: Date.now() });
    batch.set(doc(db, 'households/h3/lists/groceries'), { name: 'Groceries' });
    await assertSucceeds(batch.commit());
  });

  it('blocks creating a household that adds someone else', async () => {
    await assertFails(setDoc(doc(as(MALLORY), 'households/h2'), { name: 'Mine', members: [MALLORY, ALICE], createdAt: Date.now() }));
  });

  it('lets a member invite someone', async () => {
    await assertSucceeds(updateDoc(doc(as(ALICE), 'households/h1'), { members: arrayUnion('carol@example.com') }));
  });

  it('blocks a non-member from adding themselves', async () => {
    await assertFails(updateDoc(doc(as(MALLORY), 'households/h1'), { members: arrayUnion(MALLORY) }));
  });

  it('lets a member record their own first sign-in', async () => {
    await assertSucceeds(updateDoc(doc(as(BOB), 'households/h1'), { joined: arrayUnion(BOB) }));
  });

  it('blocks a member from marking someone else as joined', async () => {
    await assertFails(updateDoc(doc(as(BOB), 'households/h1'), { joined: arrayUnion(ALICE) }));
  });

  it('blocks a member from removing themselves', async () => {
    await assertFails(updateDoc(doc(as(ALICE), 'households/h1'), { members: [BOB] }));
  });
});

describe('household contents', () => {
  it('lets members read and write items', async () => {
    const db = as(BOB);
    await assertSucceeds(getDoc(doc(db, 'households/h1/items/i1')));
    await assertSucceeds(setDoc(doc(db, 'households/h1/items/i2'), { name: 'Eggs', listId: 'groceries', completed: false }));
  });

  it('blocks non-members from items, lists and staples', async () => {
    const db = as(MALLORY);
    await assertFails(getDoc(doc(db, 'households/h1/items/i1')));
    await assertFails(setDoc(doc(db, 'households/h1/lists/l1'), { name: 'Sneaky' }));
    await assertFails(getDoc(doc(db, 'households/h1/staples/milk')));
  });

  it('lets members save and read meal ideas, and nobody else', async () => {
    const menu = { createdAt: 1, createdBy: 'Bob', ingredients: ['eggs'], meals: [] };
    await assertSucceeds(setDoc(doc(as(BOB), 'households/h1/menus/m1'), menu));
    await assertSucceeds(getDoc(doc(as(ALICE), 'households/h1/menus/m1')));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/menus/m1')));
    await assertFails(setDoc(doc(as(MALLORY), 'households/h1/menus/m2'), menu));
  });

  it('caps checklists at 50 steps', async () => {
    const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, text: `Step ${i}`, done: false }));
    const db = as(ALICE);
    await assertSucceeds(setDoc(doc(db, 'households/h1/items/c1'), { name: 'List', listId: 'chores', completed: false, subtasks: steps(50) }));
    await assertFails(setDoc(doc(db, 'households/h1/items/c2'), { name: 'List', listId: 'chores', completed: false, subtasks: steps(51) }));
  });

  it('lets members plan meals by day and slot, with only the known fields', async () => {
    const slot = { day: '2031-01-06', type: 'dinner', name: 'Baked salmon with rice', meal: { type: 'dinner', name: 'Baked salmon with rice', parts: [] }, by: ALICE, updatedAt: 1 };
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/mealPlan/2031-01-06_dinner'), slot));
    await assertSucceeds(getDoc(doc(as(BOB), 'households/h1/mealPlan/2031-01-06_dinner')));
    await assertSucceeds(setDoc(doc(as(BOB), 'households/h1/mealPlan/2031-01-06_dinner'), { ...slot, name: 'Tofu bowl', by: BOB }));
    await assertSucceeds(deleteDoc(doc(as(BOB), 'households/h1/mealPlan/2031-01-06_dinner')));
    // Outsiders, a slot id that does not match, an unknown meal type or field, or writing as someone else.
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/mealPlan/2031-01-06_dinner')));
    await assertFails(setDoc(doc(as(MALLORY), 'households/h1/mealPlan/2031-01-06_dinner'), { ...slot, by: MALLORY }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/mealPlan/2031-01-07_dinner'), slot));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/mealPlan/2031-01-06_snack'), { ...slot, type: 'snack' }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/mealPlan/2031-01-06_dinner'), { ...slot, note: 'x' }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/mealPlan/2031-01-06_dinner'), { ...slot, by: BOB }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/mealPlan/2031-1-6_dinner'), { ...slot, day: '2031-1-6' }));
  });

  it('lets members save, read and remove favorite meals, and nobody else', async () => {
    const favorite = { meal: { type: 'dinner', name: 'Steak', parts: [] }, savedAt: 1, savedBy: 'Bob' };
    await assertSucceeds(setDoc(doc(as(BOB), 'households/h1/favorites/steak'), favorite));
    await assertSucceeds(getDoc(doc(as(ALICE), 'households/h1/favorites/steak')));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/favorites/steak')));
    await assertFails(getDocs(collection(as(MALLORY), 'households/h1/favorites')));
    await assertFails(setDoc(doc(as(MALLORY), 'households/h1/favorites/rice'), favorite));
    await assertFails(deleteDoc(doc(as(MALLORY), 'households/h1/favorites/steak')));
    await assertSucceeds(deleteDoc(doc(as(ALICE), 'households/h1/favorites/steak')));
  });

  it('lets members manage store layouts, validates them, and hides them from others', async () => {
    const layout = { name: 'Corner Grocer', categoryOrder: ['Frozen Foods'], aisleLabels: {}, location: null, createdAt: 1 };
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/stores/s1'), layout));
    await assertSucceeds(getDoc(doc(as(BOB), 'households/h1/stores/s1')));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/stores/s1')));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/stores/s2'), { ...layout, name: '' }));
  });

  it('lets members record learned aisles, within limits', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'households/h1/stores/s1'), { name: 'Corner Grocer', categoryOrder: [] });
    });
    const aisle = { aisle: '12', name: 'Milk', updatedAt: 1, updatedBy: 'Bob' };
    await assertSucceeds(setDoc(doc(as(BOB), 'households/h1/stores/s1/aisles/milk'), aisle));
    await assertSucceeds(getDoc(doc(as(ALICE), 'households/h1/stores/s1/aisles/milk')));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/stores/s1/aisles/milk')));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/stores/s1/aisles/eggs'), { ...aisle, aisle: '' }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/stores/s1/aisles/eggs'), { ...aisle, aisle: 'x'.repeat(25) }));
  });

  it('lets members keep the baby log, and nobody else', async () => {
    const feed = { kind: 'feed', at: 1700000000000, side: 'left', by: 'alice@example.com', createdAt: 1700000000000 };
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/babyEvents/e1'), feed));
    await assertSucceeds(getDoc(doc(as(BOB), 'households/h1/babyEvents/e1')));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/babyEvents/e1')));
    await assertFails(setDoc(doc(as(MALLORY), 'households/h1/babyEvents/e2'), feed));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/babyEvents/e3'), { ...feed, kind: 'party' }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/babyEvents/e4'), { ...feed, extra: true }));
    await assertSucceeds(deleteDoc(doc(as(BOB), 'households/h1/babyEvents/e1')));
  });

  it('lets each member record only their own profile, readable by members', async () => {
    const me = { name: 'Alice Example', photoURL: 'https://example.com/a.png', updatedAt: 1 };
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/profiles/alice@example.com'), me));
    await assertSucceeds(getDoc(doc(as(BOB), 'households/h1/profiles/alice@example.com')));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/profiles/alice@example.com')));
    await assertFails(setDoc(doc(as(BOB), 'households/h1/profiles/alice@example.com'), me));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/profiles/alice@example.com'), { ...me, photoURL: 'javascript:x' }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/profiles/alice@example.com'), { ...me, role: 'admin' }));
  });

  it('lets members keep shared contacts, with only the known fields', async () => {
    const vet = { name: 'Example Vet', role: 'Vet', phone: '+1 555 0100', apps: ['pet'], createdAt: 1, by: 'alice@example.com' };
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/contacts/c1'), vet));
    await assertSucceeds(getDoc(doc(as(BOB), 'households/h1/contacts/c1')));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/contacts/c1')));
    await assertFails(setDoc(doc(as(MALLORY), 'households/h1/contacts/c2'), vet));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/contacts/c3'), { ...vet, ssn: 'x' }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/contacts/c4'), { ...vet, name: '' }));
    await assertSucceeds(deleteDoc(doc(as(BOB), 'households/h1/contacts/c1')));
  });

  it('lets members edit the baby profile, checklists and appointments', async () => {
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/babyProfile/main'), { dueDate: '2031-03-01', updatedAt: 1 }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/babyProfile/other'), { dueDate: '2031-03-01' }));
    await assertSucceeds(setDoc(doc(as(BOB), 'households/h1/babyChecklists/c1'), { list: 'hospital-bag', text: 'Charger', done: false }));
    await assertFails(setDoc(doc(as(BOB), 'households/h1/babyChecklists/c2'), { list: 'hospital-bag', text: '' }));
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/babyAppointments/a1'), { title: 'Checkup', at: 1700000000000 }));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/babyAppointments/a1')));
  });

  describe('Huishouden Car', () => {
    const stamp = { createdAt: 1700000000000, by: 'alice@example.com' };
    const car = { name: 'Family van', make: 'Example', model: 'Wagon', year: 2027, ...stamp };
    const oil = { vehicleId: 'v1', name: 'Oil change', everyMonths: 6, everyDistance: 5000, lastDate: '2031-01-10', lastOdometer: 41200, ...stamp };
    const reading = { vehicleId: 'v1', date: '2031-04-01', reading: 42180, ...stamp };
    const registration = { vehicleId: 'v1', kind: 'registration', name: 'Registration', dueDate: '2031-04-27', everyMonths: 12, ...stamp };
    const visit = { vehicleId: 'v1', date: '2031-01-10', odometer: 41200, what: 'Oil change', serviceItemIds: ['s1'], shopId: 'c1', costCents: 8999, ...stamp };
    const appointment = { vehicleId: 'v1', title: 'Tire rotation', at: 1700000000000, shopId: 'c1', calendarLink: 'https://calendar.example.com/e1', ...stamp };

    it('lets members keep cars, schedules, odometer readings, renewals, history and appointments', async () => {
      const db = as(ALICE);
      await assertSucceeds(setDoc(doc(db, 'households/h1/carVehicles/v1'), car));
      await assertSucceeds(setDoc(doc(db, 'households/h1/carServiceItems/s1'), oil));
      await assertSucceeds(setDoc(doc(db, 'households/h1/carOdometer/o1'), reading));
      await assertSucceeds(setDoc(doc(db, 'households/h1/carRenewals/r1'), registration));
      await assertSucceeds(setDoc(doc(db, 'households/h1/carRenewals/r2'), { kind: 'toll', name: 'Toll account', dueDate: '2031-09-01', ...stamp }));
      await assertSucceeds(setDoc(doc(db, 'households/h1/carServiceLog/l1'), visit));
      await assertSucceeds(setDoc(doc(db, 'households/h1/carAppointments/a1'), appointment));
      await assertSucceeds(setDoc(doc(db, 'households/h1/carSettings/main'), { distanceUnit: 'km', updatedAt: 1, updatedBy: ALICE }));
      for (const path of ['carVehicles/v1', 'carServiceItems/s1', 'carOdometer/o1', 'carRenewals/r1', 'carServiceLog/l1', 'carAppointments/a1', 'carSettings/main']) {
        await assertSucceeds(getDoc(doc(as(BOB), `households/h1/${path}`)));
        await assertFails(getDoc(doc(as(MALLORY), `households/h1/${path}`)));
      }
      await assertSucceeds(deleteDoc(doc(as(BOB), 'households/h1/carServiceLog/l1')));
    });

    it('keeps non-members out of the car collections', async () => {
      const db = as(MALLORY);
      await assertFails(setDoc(doc(db, 'households/h1/carVehicles/v2'), car));
      await assertFails(setDoc(doc(db, 'households/h1/carOdometer/o2'), reading));
      await assertFails(setDoc(doc(db, 'households/h1/carSettings/main'), { distanceUnit: 'mi', updatedAt: 1, updatedBy: MALLORY }));
      await assertFails(getDocs(collection(db, 'households/h1/carRenewals')));
    });

    it('accepts only the known car fields, types and sizes', async () => {
      const db = as(ALICE);
      const fails = async (path: string, data: Record<string, unknown>) => assertFails(setDoc(doc(db, `households/h1/${path}`), data));
      await fails('carVehicles/v3', { ...car, vin: 'x' });
      await fails('carVehicles/v3', { ...car, name: '' });
      await fails('carVehicles/v3', { ...car, name: 'x'.repeat(61) });
      await fails('carVehicles/v3', { ...car, year: 1850 });
      await fails('carVehicles/v3', { ...car, year: '2027' });
      await fails('carServiceItems/s2', { vehicleId: 'v1', name: 'Wipers', ...stamp });
      await fails('carServiceItems/s2', { ...oil, everyMonths: 0 });
      await fails('carServiceItems/s2', { ...oil, everyDistance: 2.5 });
      await fails('carServiceItems/s2', { ...oil, lastDate: '10/01/2031' });
      await fails('carOdometer/o3', { ...reading, reading: -1 });
      await fails('carOdometer/o3', { ...reading, reading: 42180.5 });
      await fails('carOdometer/o3', { ...reading, plate: 'x' });
      await fails('carRenewals/r3', { ...registration, kind: 'parking' });
      await fails('carRenewals/r3', { ...registration, dueDate: 'soon' });
      await fails('carServiceLog/l2', { ...visit, costCents: 89.99 });
      await fails('carServiceLog/l2', { ...visit, what: '' });
      await fails('carServiceLog/l2', { ...visit, notes: 'x'.repeat(1001) });
      await fails('carAppointments/a2', { ...appointment, calendarLink: 'javascript:alert(1)' });
      await fails('carAppointments/a2', { ...appointment, at: '2031-05-01' });
      await fails('carSettings/main', { distanceUnit: 'furlongs', updatedAt: 1, updatedBy: ALICE });
      await fails('carSettings/other', { distanceUnit: 'mi', updatedAt: 1, updatedBy: ALICE });
    });
  });

  it('lets members keep Home upkeep jobs with a valid schedule, and nobody else', async () => {
    const job = {
      title: 'Change HVAC filter',
      category: 'hvac',
      schedule: { kind: 'after-done', every: 3, unit: 'month' },
      due: '2031-10-20',
      lastDone: '2031-07-20',
      createdAt: 1,
      by: ALICE,
    };
    const fixed = { ...job, title: 'HOA dues', category: 'paperwork', schedule: { kind: 'fixed', every: 1, unit: 'month', anchor: '2031-01-01' } };
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/homeTasks/t1'), job));
    await assertSucceeds(setDoc(doc(as(BOB), 'households/h1/homeTasks/t2'), { ...fixed, contactId: 'c1', calendarLink: 'https://calendar.example.com/e', updatedAt: 2 }));
    await assertSucceeds(getDoc(doc(as(BOB), 'households/h1/homeTasks/t1')));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/homeTasks/t1')));
    await assertFails(setDoc(doc(as(MALLORY), 'households/h1/homeTasks/t3'), job));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/homeTasks/t4'), { ...job, extra: true }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/homeTasks/t4'), { ...job, title: '' }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/homeTasks/t4'), { ...job, category: 'party' }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/homeTasks/t4'), { ...job, due: 'next week' }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/homeTasks/t4'), { ...job, schedule: { kind: 'fixed', every: 1, unit: 'month' } }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/homeTasks/t4'), { ...job, schedule: { kind: 'after-done', every: 0, unit: 'month' } }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/homeTasks/t4'), { ...job, schedule: { kind: 'after-done', every: 3, unit: 'decade' } }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/homeTasks/t4'), { ...job, calendarLink: 'javascript:alert(1)' }));
    await assertSucceeds(deleteDoc(doc(as(BOB), 'households/h1/homeTasks/t1')));
  });

  it('lets members keep Home regular events with a valid rule, prep and changes', async () => {
    const event = {
      title: 'Garbage pickup',
      kind: 'trash',
      rule: { freq: 'week', every: 1, start: '2031-01-02' },
      time: '07:00',
      contactId: 'c1',
      notes: 'Bins by the curb.',
      prep: { title: 'Take the garbage out', offset: { daysBefore: 1, time: '19:00' }, remind: true },
      exceptions: { '2031-12-25': { moved: { date: '2031-12-26', time: '08:00' }, note: 'Holiday week' }, '2032-01-01': { skipped: true } },
      createdAt: 1,
      by: ALICE,
    };
    const ok = (id: string, data: Record<string, unknown>) => assertSucceeds(setDoc(doc(as(ALICE), `households/h1/homeEvents/${id}`), data));
    const bad = (data: Record<string, unknown>) => assertFails(setDoc(doc(as(ALICE), 'households/h1/homeEvents/bad'), data));
    const { time: _t, contactId: _c, notes: _n, prep: _p, exceptions: _e, ...bare } = event;
    await ok('e1', event);
    await ok('e2', { ...bare, updatedAt: 2 });
    await ok('e3', { ...bare, kind: 'yard waste', rule: { freq: 'week', every: 2, start: '2031-01-03', days: [1, 4], until: '2031-12-31' } });
    await ok('e4', { ...bare, kind: 'hoa', rule: { freq: 'month', every: 1, start: '2031-01-14', nth: 2, weekday: 2 } });
    await ok('e5', { ...bare, kind: 'lawn', rule: { freq: 'month', every: 1, start: '2031-01-31', nth: -1, weekday: 5 } });
    await ok('e6', { ...bare, kind: 'other', rule: { freq: 'year', every: 1, start: '2031-06-01' }, exceptions: {} });
    await assertSucceeds(getDoc(doc(as(BOB), 'households/h1/homeEvents/e1')));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/homeEvents/e1')));
    await assertFails(setDoc(doc(as(MALLORY), 'households/h1/homeEvents/e9'), event));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/homeEvents/not_an_id'), event));

    await bad({ ...event, extra: true });
    await bad({ ...event, title: '' });
    await bad({ ...event, kind: 'party' });
    await bad({ ...event, time: '7pm' });
    await bad({ ...event, time: '24:00' });
    await bad({ ...event, rule: { freq: 'day', every: 1, start: '2031-01-02' } });
    await bad({ ...event, rule: { freq: 'week', every: 0, start: '2031-01-02' } });
    await bad({ ...event, rule: { freq: 'week', every: 100, start: '2031-01-02' } });
    await bad({ ...event, rule: { freq: 'week', every: 1 } });
    await bad({ ...event, rule: { freq: 'week', every: 1, start: '2031-01-02', days: [] } });
    await bad({ ...event, rule: { freq: 'week', every: 1, start: '2031-01-02', days: [7] } });
    await bad({ ...event, rule: { freq: 'month', every: 1, start: '2031-01-02', days: [1] } });
    await bad({ ...event, rule: { freq: 'month', every: 1, start: '2031-01-02', nth: 5, weekday: 1 } });
    await bad({ ...event, rule: { freq: 'month', every: 1, start: '2031-01-02', nth: 2 } });
    await bad({ ...event, rule: { freq: 'week', every: 1, start: '2031-01-02', nth: 2, weekday: 1 } });
    await bad({ ...event, rule: { freq: 'week', every: 1, start: '2031-01-02', until: '2030-01-01' } });
    await bad({ ...event, rule: { freq: 'week', every: 1, start: '2031-01-02', by: 'x' } });
    await bad({ ...event, prep: { title: 'Take it out', offset: { daysBefore: 1, time: '19:00' } } });
    await bad({ ...event, prep: { title: '', offset: { daysBefore: 1, time: '19:00' }, remind: true } });
    await bad({ ...event, prep: { title: 'Take it out', offset: { daysBefore: 15, time: '19:00' }, remind: true } });
    await bad({ ...event, prep: { title: 'Take it out', offset: { daysBefore: 1, time: 'evening' }, remind: true } });
    await bad({ ...event, prep: { title: 'Take it out', offset: { daysBefore: 1, time: '19:00', extra: 1 }, remind: true } });
    await bad({ ...event, prep: { title: 'Take it out', offset: { daysBefore: 1, time: '19:00' }, remind: 'yes' } });
    await bad({ ...event, exceptions: { 'next thursday': { skipped: true } } });
    await bad({ ...event, exceptions: 'none' });
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`2031-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, { skipped: true }]));
    await bad({ ...event, exceptions: many });
    await assertSucceeds(deleteDoc(doc(as(BOB), 'households/h1/homeEvents/e1')));
  });

  it('lets members keep the Home service history with whole-cent costs', async () => {
    const visit = { date: '2031-07-28', title: 'Pest control visit', taskId: 't1', contactId: 'c1', costCents: 9500, notes: 'Garage too.', createdAt: 1, by: BOB };
    await assertSucceeds(setDoc(doc(as(BOB), 'households/h1/homeServiceLog/e1'), visit));
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/homeServiceLog/e2'), { date: '2031-10-16', title: 'Change HVAC filter', who: 'We did it', createdAt: 1, by: ALICE }));
    await assertSucceeds(getDoc(doc(as(ALICE), 'households/h1/homeServiceLog/e1')));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/homeServiceLog/e1')));
    await assertFails(setDoc(doc(as(MALLORY), 'households/h1/homeServiceLog/e3'), visit));
    await assertFails(setDoc(doc(as(BOB), 'households/h1/homeServiceLog/e3'), { ...visit, costCents: 95.5 }));
    await assertFails(setDoc(doc(as(BOB), 'households/h1/homeServiceLog/e3'), { ...visit, costCents: -1 }));
    await assertFails(setDoc(doc(as(BOB), 'households/h1/homeServiceLog/e3'), { ...visit, date: 1700000000000 }));
    await assertFails(setDoc(doc(as(BOB), 'households/h1/homeServiceLog/e3'), { ...visit, notes: 'x'.repeat(1001) }));
    await assertFails(setDoc(doc(as(BOB), 'households/h1/homeServiceLog/e3'), { ...visit, card: '4111' }));
    await assertSucceeds(deleteDoc(doc(as(ALICE), 'households/h1/homeServiceLog/e1')));
  });

  it('lets members keep Home warranties with https links only', async () => {
    const fridge = {
      item: 'Refrigerator',
      details: 'Example EX-200',
      purchaseDate: '2029-12-01',
      warrantyEnd: '2031-12-01',
      receiptUrl: 'https://receipts.example.com/fridge.pdf',
      createdAt: 1,
      by: ALICE,
    };
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/homeWarranties/w1'), fridge));
    await assertSucceeds(setDoc(doc(as(BOB), 'households/h1/homeWarranties/w2'), { item: 'Roof', createdAt: 1, by: BOB }));
    await assertSucceeds(getDoc(doc(as(BOB), 'households/h1/homeWarranties/w1')));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/homeWarranties/w1')));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/homeWarranties/w3'), { ...fridge, item: '' }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/homeWarranties/w3'), { ...fridge, manualUrl: 'http://example.com/manual' }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/homeWarranties/w3'), { ...fridge, warrantyEnd: '1 Dec' }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/homeWarranties/w3'), { ...fridge, price: 1 }));
    await assertSucceeds(deleteDoc(doc(as(BOB), 'households/h1/homeWarranties/w1')));
  });

  describe('portal layout', () => {
    const path = 'households/h1/settings/portal';
    const layout = { order: ['tasks', 'home', 'pet', 'car', 'bills', 'spending', 'baby'], hidden: ['baby'], updatedAt: 1, by: ALICE };

    it('lets members read and save the layout', async () => {
      await assertSucceeds(setDoc(doc(as(ALICE), path), layout));
      await assertSucceeds(getDoc(doc(as(BOB), path)));
      await assertSucceeds(setDoc(doc(as(BOB), path), { order: [], hidden: [], updatedAt: 2, by: BOB }));
    });

    it('keeps it from non-members and signed-out visitors', async () => {
      await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), path), layout));
      await assertFails(getDoc(doc(as(MALLORY), path)));
      await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), path)));
      await assertFails(setDoc(doc(as(MALLORY), path), layout));
    });

    it('allows only the portal document and never deletes it', async () => {
      await assertFails(setDoc(doc(as(ALICE), 'households/h1/settings/other'), layout));
      await assertSucceeds(setDoc(doc(as(ALICE), path), layout));
      await assertFails(deleteDoc(doc(as(ALICE), path)));
    });

    it('checks the fields', async () => {
      const fails = (data: object) => assertFails(setDoc(doc(as(ALICE), path), data));
      const thirty = Array.from({ length: 30 }, (_, i) => `app-${i}`);
      await assertSucceeds(setDoc(doc(as(ALICE), path), { ...layout, order: thirty, hidden: thirty }));
      await assertSucceeds(setDoc(doc(as(ALICE), path), { ...layout, order: ['x'.repeat(40)] }));
      await fails({ ...layout, colour: 'green' });
      await fails({ order: layout.order, updatedAt: 1, by: ALICE });
      await fails({ ...layout, order: [...thirty, 'one-more'] });
      await fails({ ...layout, hidden: [...thirty, 'one-more'] });
      await fails({ ...layout, order: ['x'.repeat(41)] });
      await fails({ ...layout, hidden: ['tasks', ''] });
      await fails({ ...layout, hidden: ['tasks/home'] });
      await fails({ ...layout, order: [...thirty.slice(0, 29), 7] });
      await fails({ ...layout, hidden: ['tasks', { repo: 'home' }] });
      await fails({ ...layout, order: 'tasks,home' });
      await fails({ ...layout, updatedAt: '2026-10-02' });
      await fails({ ...layout, updatedAt: 1.5 });
      await fails({ ...layout, by: 42 });
    });
  });

  describe('Tasks settings', () => {
    const path = 'households/h1/settings/tasks';
    const link = { googleListId: 'MTIzNDU2', title: 'My Tasks', listId: 'chores', mode: 'suggest' };
    const tasks = { googleTasks: [link, { ...link, googleListId: 'Z3JvY2', title: 'Groceries', listId: 'groceries', mode: 'add' }], updatedAt: 1, by: ALICE };

    it('lets members read and save which Google Tasks lists feed which list, and nobody else', async () => {
      await assertSucceeds(setDoc(doc(as(ALICE), path), tasks));
      await assertSucceeds(getDoc(doc(as(BOB), path)));
      await assertSucceeds(setDoc(doc(as(BOB), path), { ...tasks, googleTasks: [], by: BOB }));
      await assertFails(getDoc(doc(as(MALLORY), path)));
      await assertFails(setDoc(doc(as(MALLORY), path), { ...tasks, by: MALLORY }));
      await assertFails(deleteDoc(doc(as(ALICE), path)));
    });

    it('checks the shape', async () => {
      await assertFails(setDoc(doc(as(ALICE), path), { ...tasks, by: BOB }));
      await assertFails(setDoc(doc(as(ALICE), path), { ...tasks, extra: true }));
      await assertFails(setDoc(doc(as(ALICE), path), { googleTasks: tasks.googleTasks, by: ALICE }));
      await assertFails(setDoc(doc(as(ALICE), path), { ...tasks, googleTasks: 'My Tasks' }));
      await assertFails(setDoc(doc(as(ALICE), path), { ...tasks, googleTasks: Array.from({ length: 11 }, () => link) }));
      await assertFails(setDoc(doc(as(ALICE), path), { ...tasks, updatedAt: '2031-01-06' }));
      await assertFails(setDoc(doc(as(ALICE), path), { ...tasks, handled: 'dGFzaw' }));
      await assertFails(setDoc(doc(as(ALICE), path), { ...tasks, handled: Array.from({ length: 501 }, (_, i) => `t${i}`) }));
    });

    it('keeps the Google tasks already taken in', async () => {
      await assertSucceeds(setDoc(doc(as(ALICE), path), { ...tasks, handled: ['dGFzay1lZ2dz', 'dGFzay1taWxr'] }));
      await assertSucceeds(setDoc(doc(as(BOB), path), { ...tasks, handled: Array.from({ length: 500 }, (_, i) => `t${i}`), by: BOB }));
    });
  });

  describe('food preferences', () => {
    const path = 'households/h1/settings/food';
    const sam = { id: ALICE, name: 'Alice', member: ALICE, diets: ['gerd', 'pregnant'], avoid: ['cilantro'], note: 'Dinner before 7' };
    const kid = { id: 'kid-1', name: 'Robin', diets: ['nut allergy'], avoid: [] };
    const food = { people: [sam, kid], pantryAssumed: ['salt', 'black pepper', 'cooking oil'], updatedAt: 1, by: ALICE };

    it('lets members read and save them, and nobody else', async () => {
      await assertSucceeds(setDoc(doc(as(ALICE), path), food));
      await assertSucceeds(getDoc(doc(as(BOB), path)));
      await assertSucceeds(setDoc(doc(as(BOB), path), { people: [], pantryAssumed: [], updatedAt: 2, by: BOB }));
      await assertFails(getDoc(doc(as(MALLORY), path)));
      await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), path)));
      await assertFails(setDoc(doc(as(MALLORY), path), { ...food, by: MALLORY }));
      await assertFails(deleteDoc(doc(as(ALICE), path)));
    });

    it('accepts the most the kit saves', async () => {
      const full = (i: number) => ({
        id: `person-${i}`.padEnd(60, 'x'),
        name: 'n'.repeat(60),
        member: `${'m'.repeat(240)}@example.com`,
        diets: ['vegan', 'vegetarian', 'pescatarian', 'gluten-free', 'dairy-free', 'nut allergy', 'shellfish allergy', 'gerd', 'pregnant', 'low-sodium', 'halal', 'kosher'],
        avoid: Array.from({ length: 30 }, (_, j) => `${j}`.padEnd(40, 'a')),
        note: 'z'.repeat(200),
      });
      const pantry = Array.from({ length: 40 }, (_, j) => `${j}`.padEnd(40, 'p'));
      await assertSucceeds(setDoc(doc(as(ALICE), path), { ...food, people: Array.from({ length: 20 }, (_, i) => full(i)), pantryAssumed: pantry }));
    });

    it('checks the document', async () => {
      const fails = (data: object) => assertFails(setDoc(doc(as(ALICE), path), data));
      await fails({ ...food, colour: 'green' });
      await fails({ people: food.people, updatedAt: 1, by: ALICE });
      await fails({ ...food, by: BOB });
      await fails({ ...food, updatedAt: '2026-10-02' });
      await fails({ ...food, people: 'Alice' });
      await fails({ ...food, people: Array.from({ length: 21 }, (_, i) => ({ ...kid, id: `k${i}` })) });
      await fails({ ...food, pantryAssumed: Array.from({ length: 41 }, (_, j) => `p${j}`) });
      await fails({ ...food, pantryAssumed: ['salt|pepper'] });
      await fails({ ...food, pantryAssumed: ['salt', ''] });
      await fails({ ...food, pantryAssumed: ['x'.repeat(41)] });
      await fails({ ...food, pantryAssumed: ['salt', 7] });
      await fails({ ...food, pantryAssumed: 'salt' });
    });
  });

  describe('reminders', () => {
    const reminder = {
      app: 'pet',
      title: 'Give Biscuit 1 tablet',
      body: 'With food',
      at: 1700000000000,
      url: 'https://example-pet.web.app/meds/m1',
      recipients: 'all',
      ref: 'course:m1',
      sent: false,
      createdAt: 1700000000000,
      by: ALICE,
    };

    it('lets members create, read, update and delete reminders', async () => {
      await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/reminders/r1'), reminder));
      await assertSucceeds(getDoc(doc(as(BOB), 'households/h1/reminders/r1')));
      await assertSucceeds(getDocs(collection(as(BOB), 'households/h1/reminders')));
      await assertSucceeds(updateDoc(doc(as(BOB), 'households/h1/reminders/r1'), { at: 1700000600000, recipients: [BOB] }));
      await assertSucceeds(updateDoc(doc(as(ALICE), 'households/h1/reminders/r1'), { sent: true, sentAt: 1700000600000 }));
      await assertSucceeds(deleteDoc(doc(as(BOB), 'households/h1/reminders/r1')));
    });

    it('keeps non-members out', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'households/h1/reminders/r1'), reminder);
      });
      const db = as(MALLORY);
      await assertFails(getDoc(doc(db, 'households/h1/reminders/r1')));
      await assertFails(getDocs(collection(db, 'households/h1/reminders')));
      await assertFails(setDoc(doc(db, 'households/h1/reminders/r2'), reminder));
      await assertFails(deleteDoc(doc(db, 'households/h1/reminders/r1')));
    });

    it('accepts only the known reminder fields and shapes', async () => {
      const fails = (data: Record<string, unknown>) => assertFails(setDoc(doc(as(ALICE), 'households/h1/reminders/r3'), data));
      await fails({ ...reminder, extra: true });
      await fails({ ...reminder, url: 'javascript:alert(1)' });
      await fails({ ...reminder, recipients: 'everyone' });
      await fails({ ...reminder, recipients: [] });
      await fails({ ...reminder, recipients: Array.from({ length: 13 }, (_, i) => `p${i}@example.com`) });
      await fails({ ...reminder, at: '2031-05-01' });
      await fails({ ...reminder, title: '' });
      const { sent: _sent, ...withoutSent } = reminder;
      await fails(withoutSent);
      await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/reminders/r4'), { ...reminder, recipients: [ALICE, BOB], body: '' }));
    });
  });

  describe('agenda', () => {
    const item = {
      app: 'home',
      ref: 'job:j1',
      kind: 'due',
      title: 'Change HVAC filter',
      start: 1790000000000,
      allDay: true,
      detail: 'Furnace room',
      url: 'https://example-home.web.app/upkeep/j1',
      status: 'upcoming',
      updatedAt: 1790000000000,
      by: ALICE,
    };
    const path = 'households/h1/agenda/home_job_j1_1790000000000';

    it('lets members create, read, query, update and delete agenda items', async () => {
      await assertSucceeds(setDoc(doc(as(ALICE), path), item));
      await assertSucceeds(getDoc(doc(as(BOB), path)));
      await assertSucceeds(getDocs(query(collection(as(BOB), 'households/h1/agenda'), where('start', '<', 1800000000000))));
      await assertSucceeds(getDocs(query(collection(as(BOB), 'households/h1/agenda'), where('app', '==', 'home'), where('ref', '==', 'job:j1'))));
      await assertSucceeds(setDoc(doc(as(BOB), path), { ...item, status: 'overdue', by: BOB }));
      await assertSucceeds(setDoc(doc(as(BOB), 'households/h1/agenda/a2'), {
        ...item, kind: 'appointment', allDay: false, end: 1790003600000, who: 'Biscuit', by: BOB,
      }));
      await assertSucceeds(deleteDoc(doc(as(ALICE), path)));
    });

    it('keeps non-members out', async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), path), item);
      });
      const db = as(MALLORY);
      await assertFails(getDoc(doc(db, path)));
      await assertFails(getDocs(collection(db, 'households/h1/agenda')));
      await assertFails(setDoc(doc(db, 'households/h1/agenda/a3'), { ...item, by: MALLORY }));
      await assertFails(deleteDoc(doc(db, path)));
    });

    it('accepts only the known fields, types and sizes', async () => {
      const fails = (data: Record<string, unknown>) => assertFails(setDoc(doc(as(ALICE), 'households/h1/agenda/a4'), data));
      const without = (k: keyof typeof item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== k));
      await fails({ ...item, extra: true });
      for (const k of ['app', 'ref', 'kind', 'title', 'start', 'allDay', 'url', 'updatedAt', 'by'] as const) await fails(without(k));
      await fails({ ...item, kind: 'party' });
      await fails({ ...item, status: 'late' });
      await fails({ ...item, title: '' });
      await fails({ ...item, title: 'x'.repeat(121) });
      await fails({ ...item, detail: 'x'.repeat(201) });
      await fails({ ...item, who: 'x'.repeat(61) });
      await fails({ ...item, ref: 'x'.repeat(201) });
      await fails({ ...item, start: 1790000000000.5 });
      await fails({ ...item, start: '2026-10-05' });
      await fails({ ...item, end: item.start });
      await fails({ ...item, end: '2026-10-06' });
      await fails({ ...item, allDay: 'yes' });
      await fails({ ...item, url: 'http://example-home.web.app/upkeep/j1' });
      await fails({ ...item, url: 'javascript:alert(1)//https://' });
      await fails({ ...item, updatedAt: 'now' });
      await fails({ ...item, by: BOB });
      await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/agenda/a5'), {
        ...item, title: 'x'.repeat(120), detail: 'x'.repeat(200), who: 'x'.repeat(60), end: item.start + 86400000, status: 'done',
      }));
      await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/agenda/a6'), without('status')));
    });
  });

  describe('push subscriptions', () => {
    const sub = (email: string) => ({
      email,
      app: 'pet',
      endpoint: 'https://push.example.com/send/abc123',
      keys: { p256dh: 'BExamplePublicKey', auth: 'ExampleAuth' },
      ua: 'Example Browser',
      createdAt: 1700000000000,
    });

    it('lets a member save, list and delete their own subscription', async () => {
      const db = as(ALICE);
      await assertSucceeds(setDoc(doc(db, 'households/h1/pushSubscriptions/s1'), sub(ALICE)));
      await assertSucceeds(setDoc(doc(db, 'households/h1/pushSubscriptions/s1'), { ...sub(ALICE), createdAt: 1700000600000 }));
      await assertSucceeds(getDoc(doc(db, 'households/h1/pushSubscriptions/s1')));
      await assertSucceeds(getDocs(query(collection(db, 'households/h1/pushSubscriptions'), where('email', '==', ALICE))));
      await assertSucceeds(deleteDoc(doc(db, 'households/h1/pushSubscriptions/s1')));
    });

    it("blocks saving a subscription under someone else's email", async () => {
      await assertFails(setDoc(doc(as(ALICE), 'households/h1/pushSubscriptions/s2'), sub(BOB)));
      await assertFails(setDoc(doc(as(MALLORY), 'households/h1/pushSubscriptions/s3'), sub(MALLORY)));
    });

    it("hides a member's subscription and keys from the other members", async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'households/h1/pushSubscriptions/s1'), sub(ALICE));
      });
      const db = as(BOB);
      await assertFails(getDoc(doc(db, 'households/h1/pushSubscriptions/s1')));
      await assertFails(getDocs(query(collection(db, 'households/h1/pushSubscriptions'), where('email', '==', ALICE))));
      await assertFails(getDocs(collection(db, 'households/h1/pushSubscriptions')));
      await assertFails(deleteDoc(doc(db, 'households/h1/pushSubscriptions/s1')));
      await assertFails(setDoc(doc(db, 'households/h1/pushSubscriptions/s1'), sub(BOB)));
    });

    it('accepts only the known subscription fields and keys', async () => {
      const fails = (data: Record<string, unknown>) => assertFails(setDoc(doc(as(ALICE), 'households/h1/pushSubscriptions/s4'), data));
      await fails({ ...sub(ALICE), extra: true });
      await fails({ ...sub(ALICE), keys: { p256dh: 'x', auth: 'y', private: 'z' } });
      await fails({ ...sub(ALICE), keys: { p256dh: 'x' } });
      await fails({ ...sub(ALICE), keys: 'x' });
      await fails({ ...sub(ALICE), endpoint: 'http://push.example.com/x' });
      await fails({ ...sub(ALICE), createdAt: 'now' });
    });
  });

  describe('Huishouden Pet', () => {
    const by = 'alice@example.com';
    const pet = { name: 'Biscuit', species: 'dog', breed: 'Beagle', birthDate: '2027-03-08', weightUnit: 'lb', notes: 'Lamb food only.', createdAt: 1, by };
    const reminder = { petId: 'p1', kind: 'flea-tick', title: 'Flea and tick', every: 1, unit: 'month', due: '2031-05-12', lastDoneAt: 1, createdAt: 1, by };
    const dose = { petId: 'p1', reminderId: 'r1', title: 'Flea and tick', at: 1700000000000, by, createdAt: 1700000000000 };
    const visit = {
      petIds: ['p1', 'p2'],
      kind: 'vet',
      title: 'Yearly check-up',
      at: 1700000000000,
      location: '25 Example Street',
      contactId: 'c1',
      calendarEventId: 'evt-1',
      calendarLink: 'https://calendar.example.com/event?eid=1',
      createdAt: 1,
      by,
    };
    const weight = { petId: 'p1', at: 1700000000000, value: 26.1, unit: 'lb', by, createdAt: 1700000000000 };
    const record = { petId: 'p1', title: 'Allergy test', date: '2030-11-14', text: 'Lamb only.', createdAt: 1, by };
    const meal = { petId: 'p1', name: 'AM', time: '09:00', food: 'Lamb kibble', portion: '1 cup', note: 'Supplement mixed in', createdAt: 1, by };
    const feeding = { petId: 'p1', mealId: 'p1-am', at: 1700000000000, portion: '1 cup', note: 'Ate it all', by, createdAt: 1700000000000 };
    const course = { petId: 'p1', name: 'Antibiotic', dose: '1 tablet', timesPerDay: 2, times: ['09:00', '19:00'], startDate: '2031-05-12', days: 7, withFood: true, notes: 'For the ear', createdAt: 1, by };
    const medDose = { petId: 'p1', courseId: 'k1', slot: 1, at: 1700000000000, by, createdAt: 1700000000000 };
    const cases: [string, Record<string, unknown>][] = [
      ['petMeals', meal],
      ['petFeedings', feeding],
      ['petMedCourses', course],
      ['petMedDoses', medDose],
      ['petProfiles', pet],
      ['petReminders', reminder],
      ['petDoses', dose],
      ['petAppointments', visit],
      ['petWeights', weight],
      ['petRecords', record],
    ];

    for (const [col, data] of cases) {
      it(`lets members keep ${col}, with only the known fields, and nobody else`, async () => {
        await assertSucceeds(setDoc(doc(as(ALICE), `households/h1/${col}/x1`), data));
        await assertSucceeds(getDoc(doc(as(BOB), `households/h1/${col}/x1`)));
        await assertSucceeds(setDoc(doc(as(BOB), `households/h1/${col}/x1`), { ...data, by: BOB }));
        await assertFails(getDoc(doc(as(MALLORY), `households/h1/${col}/x1`)));
        await assertFails(getDocs(collection(as(MALLORY), `households/h1/${col}`)));
        await assertFails(setDoc(doc(as(MALLORY), `households/h1/${col}/x2`), data));
        await assertFails(setDoc(doc(as(ALICE), `households/h1/${col}/x3`), { ...data, extra: true }));
        await assertFails(deleteDoc(doc(as(MALLORY), `households/h1/${col}/x1`)));
        await assertSucceeds(deleteDoc(doc(as(BOB), `households/h1/${col}/x1`)));
      });
    }

    it("keeps each pet's photo as a small WebP or JPEG data URL, members only", async () => {
      const photo = { data: 'data:image/webp;base64,UklGRg==', updatedAt: 1700000000000, by };
      const path = 'households/h1/petPhotos/p1';
      await assertSucceeds(setDoc(doc(as(ALICE), path), photo));
      await assertSucceeds(getDoc(doc(as(BOB), path)));
      await assertSucceeds(setDoc(doc(as(BOB), path), { ...photo, data: 'data:image/jpeg;base64,/9j/4AAQ', by: BOB }));
      await assertFails(getDoc(doc(as(MALLORY), path)));
      await assertFails(setDoc(doc(as(MALLORY), 'households/h1/petPhotos/p2'), photo));
      await assertFails(setDoc(doc(as(ALICE), 'households/h1/petPhotos/p2'), { ...photo, data: 'data:image/png;base64,iVBORw0KGgo=' }));
      await assertFails(setDoc(doc(as(ALICE), 'households/h1/petPhotos/p2'), { ...photo, data: 'https://example.com/biscuit.webp' }));
      await assertFails(setDoc(doc(as(ALICE), 'households/h1/petPhotos/p2'), { ...photo, data: 'data:image/webp;base64,' + 'A'.repeat(100_000) }));
      await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/petPhotos/p3'), { ...photo, data: 'data:image/webp;base64,' + 'A'.repeat(100_000 - 23) }));
      await assertFails(setDoc(doc(as(ALICE), 'households/h1/petPhotos/p2'), { ...photo, data: 42 }));
      await assertFails(setDoc(doc(as(ALICE), 'households/h1/petPhotos/p2'), { ...photo, updatedAt: 'now' }));
      await assertFails(setDoc(doc(as(ALICE), 'households/h1/petPhotos/p2'), { ...photo, caption: 'Biscuit' }));
      await assertFails(deleteDoc(doc(as(MALLORY), path)));
      await assertSucceeds(deleteDoc(doc(as(BOB), path)));
    });

    it('checks pet profiles: name, species, unit and date shape', async () => {
      const db = as(ALICE);
      await assertSucceeds(setDoc(doc(db, 'households/h1/petProfiles/p2'), { name: 'Miso', species: 'cat', weightUnit: 'kg', createdAt: 1, by }));
      await assertFails(setDoc(doc(db, 'households/h1/petProfiles/p3'), { ...pet, name: '' }));
      await assertFails(setDoc(doc(db, 'households/h1/petProfiles/p3'), { ...pet, name: 'x'.repeat(61) }));
      await assertFails(setDoc(doc(db, 'households/h1/petProfiles/p3'), { ...pet, species: 'dragon' }));
      await assertFails(setDoc(doc(db, 'households/h1/petProfiles/p3'), { ...pet, weightUnit: 'stone' }));
      await assertFails(setDoc(doc(db, 'households/h1/petProfiles/p3'), { ...pet, birthDate: 'March 2027' }));
      await assertFails(setDoc(doc(db, 'households/h1/petProfiles/p3'), { ...pet, notes: 'x'.repeat(1001) }));
      await assertFails(setDoc(doc(db, 'households/h1/petProfiles/p3'), { ...pet, createdAt: 'yesterday' }));
    });

    it("checks a pet's target weight: a positive number under 1000, with an optional short note", async () => {
      const db = as(ALICE);
      await assertSucceeds(setDoc(doc(db, 'households/h1/petProfiles/p4'), { ...pet, targetWeight: 24.5, targetNote: "Vet's goal" }));
      await assertSucceeds(setDoc(doc(db, 'households/h1/petProfiles/p4'), { ...pet, targetWeight: 12 }));
      await assertFails(setDoc(doc(db, 'households/h1/petProfiles/p5'), { ...pet, targetWeight: 0 }));
      await assertFails(setDoc(doc(db, 'households/h1/petProfiles/p5'), { ...pet, targetWeight: -3 }));
      await assertFails(setDoc(doc(db, 'households/h1/petProfiles/p5'), { ...pet, targetWeight: 1000 }));
      await assertFails(setDoc(doc(db, 'households/h1/petProfiles/p5'), { ...pet, targetWeight: '24 lb' }));
      await assertFails(setDoc(doc(db, 'households/h1/petProfiles/p5'), { ...pet, targetWeight: 24, targetNote: 'x'.repeat(201) }));
      await assertFails(setDoc(doc(db, 'households/h1/petProfiles/p5'), { ...pet, targetNote: 42 }));
    });

    it('lets a birth date be marked approximate, as a flag beside the date', async () => {
      const db = as(ALICE);
      await assertSucceeds(setDoc(doc(db, 'households/h1/petProfiles/p6'), { ...pet, birthDateApprox: true }));
      await assertSucceeds(setDoc(doc(db, 'households/h1/petProfiles/p6'), { ...pet, birthDateApprox: false }));
      await assertFails(setDoc(doc(db, 'households/h1/petProfiles/p7'), { ...pet, birthDateApprox: 'yes' }));
      const { birthDate: _birthDate, ...undated } = pet;
      await assertFails(setDoc(doc(db, 'households/h1/petProfiles/p7'), { ...undated, birthDateApprox: true }));
    });

    it('checks reminders: a schedule needs both every and unit, within bounds', async () => {
      const db = as(ALICE);
      const { every: _every, unit: _unit, ...once } = reminder;
      await assertSucceeds(setDoc(doc(db, 'households/h1/petReminders/r2'), once));
      await assertFails(setDoc(doc(db, 'households/h1/petReminders/r3'), { ...once, every: 1 }));
      await assertFails(setDoc(doc(db, 'households/h1/petReminders/r3'), { ...once, unit: 'month' }));
      await assertFails(setDoc(doc(db, 'households/h1/petReminders/r3'), { ...reminder, every: 0 }));
      await assertFails(setDoc(doc(db, 'households/h1/petReminders/r3'), { ...reminder, every: 366 }));
      await assertFails(setDoc(doc(db, 'households/h1/petReminders/r3'), { ...reminder, every: 1.5 }));
      await assertFails(setDoc(doc(db, 'households/h1/petReminders/r3'), { ...reminder, unit: 'fortnight' }));
      await assertFails(setDoc(doc(db, 'households/h1/petReminders/r3'), { ...reminder, kind: 'party' }));
      await assertFails(setDoc(doc(db, 'households/h1/petReminders/r3'), { ...reminder, due: 1700000000000 }));
      await assertFails(setDoc(doc(db, 'households/h1/petReminders/r3'), { ...reminder, title: 'x'.repeat(81) }));
    });

    it('records a dose and the next due date in one batch', async () => {
      const db = as(BOB);
      const batch = writeBatch(db);
      batch.set(doc(db, 'households/h1/petDoses/d1'), dose);
      batch.set(doc(db, 'households/h1/petReminders/r1'), { ...reminder, due: '2031-06-14', lastDoneAt: 1700000000000, updatedAt: 1700000000000 });
      await assertSucceeds(batch.commit());
      await assertFails(setDoc(doc(db, 'households/h1/petDoses/d2'), { ...dose, at: '2031-05-14' }));
    });

    it('checks appointments: pets list, kind, title and calendar link', async () => {
      const db = as(ALICE);
      await assertSucceeds(setDoc(doc(db, 'households/h1/petAppointments/a2'), { petIds: [], kind: 'other', title: 'Kennel tour', at: 1, createdAt: 1, by }));
      await assertFails(setDoc(doc(db, 'households/h1/petAppointments/a3'), { ...visit, petIds: Array.from({ length: 11 }, (_, i) => `p${i}`) }));
      await assertFails(setDoc(doc(db, 'households/h1/petAppointments/a3'), { ...visit, petIds: 'p1' }));
      await assertFails(setDoc(doc(db, 'households/h1/petAppointments/a3'), { ...visit, kind: 'party' }));
      await assertFails(setDoc(doc(db, 'households/h1/petAppointments/a3'), { ...visit, title: '' }));
      await assertFails(setDoc(doc(db, 'households/h1/petAppointments/a3'), { ...visit, calendarLink: 'javascript:alert(1)' }));
      await assertFails(setDoc(doc(db, 'households/h1/petAppointments/a3'), { ...visit, notes: 'x'.repeat(501) }));
    });

    it('checks weights: a positive number in kg or lb', async () => {
      const db = as(ALICE);
      await assertSucceeds(setDoc(doc(db, 'households/h1/petWeights/w2'), { ...weight, value: 4, unit: 'kg' }));
      await assertFails(setDoc(doc(db, 'households/h1/petWeights/w3'), { ...weight, value: 0 }));
      await assertFails(setDoc(doc(db, 'households/h1/petWeights/w3'), { ...weight, value: '26.1' }));
      await assertFails(setDoc(doc(db, 'households/h1/petWeights/w3'), { ...weight, value: 5000 }));
      await assertFails(setDoc(doc(db, 'households/h1/petWeights/w3'), { ...weight, unit: 'stone' }));
    });

    it('checks meals and feeds: a name, a 24-hour time, an int time logged', async () => {
      const db = as(ALICE);
      await assertSucceeds(setDoc(doc(db, 'households/h1/petMeals/m2'), { petId: 'p1', name: 'PM', time: '19:00', createdAt: 1, by }));
      await assertSucceeds(setDoc(doc(db, 'households/h1/petFeedings/f2'), { petId: 'p1', at: 1, by, createdAt: 1 }));
      await assertFails(setDoc(doc(db, 'households/h1/petMeals/m3'), { ...meal, name: '' }));
      await assertFails(setDoc(doc(db, 'households/h1/petMeals/m3'), { ...meal, time: '7am' }));
      await assertFails(setDoc(doc(db, 'households/h1/petMeals/m3'), { ...meal, time: '24:00' }));
      await assertFails(setDoc(doc(db, 'households/h1/petMeals/m3'), { ...meal, portion: 'x'.repeat(41) }));
      await assertFails(setDoc(doc(db, 'households/h1/petFeedings/f3'), { ...feeding, at: '07:12' }));
      await assertFails(setDoc(doc(db, 'households/h1/petFeedings/f3'), { ...feeding, note: 'x'.repeat(201) }));
    });

    it('checks medicine courses: one time per dose, 1 to 365 days, a with-food flag', async () => {
      const db = as(ALICE);
      await assertFails(setDoc(doc(db, 'households/h1/petMedCourses/k3'), { ...course, times: ['09:00'] }));
      await assertFails(setDoc(doc(db, 'households/h1/petMedCourses/k3'), { ...course, timesPerDay: 7, times: Array(7).fill('09:00') }));
      await assertFails(setDoc(doc(db, 'households/h1/petMedCourses/k3'), { ...course, days: 0 }));
      await assertFails(setDoc(doc(db, 'households/h1/petMedCourses/k3'), { ...course, days: 400 }));
      await assertFails(setDoc(doc(db, 'households/h1/petMedCourses/k3'), { ...course, withFood: 'yes' }));
      await assertFails(setDoc(doc(db, 'households/h1/petMedCourses/k3'), { ...course, startDate: 'today' }));
      await assertFails(setDoc(doc(db, 'households/h1/petMedDoses/q3'), { ...medDose, slot: 6 }));
      await assertFails(setDoc(doc(db, 'households/h1/petMedDoses/q3'), { ...medDose, courseId: '' }));
    });

    it('checks records: title, date and text length', async () => {
      const db = as(ALICE);
      await assertFails(setDoc(doc(db, 'households/h1/petRecords/x3'), { ...record, title: '' }));
      await assertFails(setDoc(doc(db, 'households/h1/petRecords/x3'), { ...record, date: '14 Nov 2030' }));
      await assertFails(setDoc(doc(db, 'households/h1/petRecords/x3'), { ...record, text: 'x'.repeat(2001) }));
    });
  });

  it('rejects items without a name', async () => {
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/items/i3'), { name: '', listId: 'groceries', completed: false }));
  });
});

describe('Huishouden Bills', () => {
  const source = { name: 'Example Power Co', kind: 'electric', from: 'billing@power.example.com', autopay: null, createdAt: 1, createdBy: ALICE, updatedAt: 1 };
  const bill = {
    schema: 'bill/v1',
    source: 'email',
    sourceId: 'power',
    kind: 'electric',
    label: 'Example Power Co',
    due: '2031-05-20',
    amountDue: { amount: '120.00', currency: 'USD' },
    status: 'due',
    autopay: { enrolled: true, nextDraft: '2031-05-20' },
    period: { start: '2031-04-01', end: '2031-04-30' },
    emailId: 'msg-0001',
    createdAt: 1,
    createdBy: ALICE,
    updatedAt: 1,
    observedAt: 1,
  };
  const check = { checkedAt: 1, by: BOB, sources: 1, emails: 2, bills: 1, errors: [] };

  it('lets members keep bill sources with a way to match emails, and nobody else', async () => {
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/billSources/power'), source));
    await assertSucceeds(getDoc(doc(as(BOB), 'households/h1/billSources/power')));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/billSources/power')));
    await assertFails(setDoc(doc(as(MALLORY), 'households/h1/billSources/x'), source));
    const { from: _from, ...noMatch } = source;
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/billSources/none'), noMatch));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/billSources/kind'), { ...source, kind: 'casino' }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/billSources/extra'), { ...source, password: 'x' }));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/billSources/link'), { ...source, payUrl: 'javascript:alert(1)' }));
    await assertSucceeds(deleteDoc(doc(as(BOB), 'households/h1/billSources/power')));
  });

  it('lets members write bills in the bill/v1 shape, mark them paid and remove them', async () => {
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/bills/power_2031-05-20'), bill));
    await assertSucceeds(getDoc(doc(as(BOB), 'households/h1/bills/power_2031-05-20')));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/bills/power_2031-05-20')));
    await assertFails(setDoc(doc(as(MALLORY), 'households/h1/bills/x'), bill));
    await assertSucceeds(updateDoc(doc(as(BOB), 'households/h1/bills/power_2031-05-20'), { status: 'paid', paidAt: 2, paidBy: BOB, paidVia: 'member', updatedAt: 2 }));
    await assertSucceeds(updateDoc(doc(as(BOB), 'households/h1/bills/power_2031-05-20'), { dismissed: true, updatedAt: 3 }));
    const manual = { schema: 'bill/v1', source: 'manual', kind: 'insurance', label: 'Example Mutual', due: null, amountDue: null, status: 'due', autopay: null, repeat: 'quarterly', createdAt: 1, createdBy: ALICE, updatedAt: 1 };
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/bills/m1'), manual));
    await assertSucceeds(deleteDoc(doc(as(ALICE), 'households/h1/bills/m1')));
  });

  it('refuses bills with unknown fields or malformed money, dates and autopay', async () => {
    const at = (id: string, data: object) => setDoc(doc(as(ALICE), `households/h1/bills/${id}`), data);
    await assertFails(at('b1', { ...bill, accountNumber: '0000' }));
    await assertFails(at('b2', { ...bill, amountDue: { amount: 120, currency: 'USD' } }));
    await assertFails(at('b3', { ...bill, amountDue: { amount: '120.5', currency: 'USD' } }));
    await assertFails(at('b4', { ...bill, due: 'May 20' }));
    await assertFails(at('b5', { ...bill, autopay: { enrolled: 'yes' } }));
    await assertFails(at('b6', { ...bill, status: 'late' }));
    await assertFails(at('b7', { ...bill, schema: 'bill/v2' }));
    await assertFails(at('b8', { ...bill, period: { start: '2031-04-01' , end: 'soon' } }));
    await assertSucceeds(at('b9', { ...bill, amountDue: { amount: '-15.00', currency: 'USD' }, status: 'credit' }));
  });

  it("lets each member record only their own email check, readable by members", async () => {
    await assertSucceeds(setDoc(doc(as(BOB), `households/h1/billSync/${BOB}`), check));
    await assertSucceeds(getDoc(doc(as(ALICE), `households/h1/billSync/${BOB}`)));
    await assertFails(getDoc(doc(as(MALLORY), `households/h1/billSync/${BOB}`)));
    await assertFails(setDoc(doc(as(ALICE), `households/h1/billSync/${BOB}`), check));
    await assertFails(setDoc(doc(as(BOB), `households/h1/billSync/${BOB}`), { ...check, by: ALICE }));
    await assertFails(setDoc(doc(as(BOB), `households/h1/billSync/${BOB}`), { ...check, errors: Array.from({ length: 21 }, (_, i) => `e${i}`) }));
    await assertFails(setDoc(doc(as(BOB), `households/h1/billSync/${BOB}`), { ...check, token: 'x' }));
  });
});

describe('Huishouden Spending', () => {
  const tx = (extra: Record<string, unknown> = {}) => ({
    date: '2031-03-14',
    description: 'EXAMPLE GROCERY',
    amount: 61.15,
    category: 'Groceries',
    card: 'Card One',
    type: 'Sale',
    source: 'statement',
    last4: '1111',
    createdAt: 1,
    by: ALICE,
    ...extra,
  });

  it('lets members write, change and remove transactions, and nobody else', async () => {
    const db = as(ALICE);
    await assertSucceeds(setDoc(doc(db, 'households/h1/spendingTransactions/st-1'), tx()));
    await assertSucceeds(setDoc(doc(db, 'households/h1/spendingTransactions/al-m1'), tx({ source: 'alert', emailId: 'm1', amount: -18, type: 'Return' })));
    await assertSucceeds(setDoc(doc(as(BOB), 'households/h1/spendingTransactions/st-1'), tx({ category: 'Home & Garden', updatedAt: 2, by: BOB })));
    await assertSucceeds(getDocs(collection(as(BOB), 'households/h1/spendingTransactions')));
    await assertFails(getDocs(collection(as(MALLORY), 'households/h1/spendingTransactions')));
    await assertFails(setDoc(doc(as(MALLORY), 'households/h1/spendingTransactions/st-2'), tx()));
    await assertFails(deleteDoc(doc(as(MALLORY), 'households/h1/spendingTransactions/st-1')));
    await assertSucceeds(deleteDoc(doc(db, 'households/h1/spendingTransactions/st-1')));
  });

  it('refuses transactions with unknown fields or malformed dates, amounts, sources and digits', async () => {
    const ref = doc(as(ALICE), 'households/h1/spendingTransactions/bad');
    await assertFails(setDoc(ref, tx({ merchant: 'x' })));
    await assertFails(setDoc(ref, tx({ date: '03/14/2031' })));
    await assertFails(setDoc(ref, tx({ amount: '61.15' })));
    await assertFails(setDoc(ref, tx({ source: 'sheet' })));
    await assertFails(setDoc(ref, tx({ last4: '12345' })));
    await assertFails(setDoc(ref, tx({ description: '' })));
    const { createdAt: _c, ...noCreated } = tx();
    await assertFails(setDoc(ref, noCreated));
  });

  it("leaves the legacy Apps Script's mirrored documents readable and re-writable by members", async () => {
    // The script writes with its owner's IAM credentials (rules bypassed), with a timestamp updatedAt.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'households/h1/spendingTransactions/abc123'), {
        date: '2031-03-10', description: 'EXAMPLE BOOKSHOP', amount: 27.1, category: 'Shopping', card: 'Card Two', type: 'Sale', source: 'alert', updatedAt: new Date(),
      });
    });
    await assertSucceeds(getDoc(doc(as(ALICE), 'households/h1/spendingTransactions/abc123')));
    // A statement row replacing the alert rewrites the whole document in the members' shape.
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/spendingTransactions/abc123'), tx({ description: 'EXAMPLE BOOKSHOP #12', updatedAt: 3 })));
  });

  it('keeps one settings document with the known fields', async () => {
    const db = as(ALICE);
    const settings = { monthlyBudget: 2000, currencySymbol: '$', ignoredKeywords: ['rent payment'], alertLabels: ['Bank/Alerts'], updatedAt: 1, updatedBy: ALICE };
    await assertSucceeds(setDoc(doc(db, 'households/h1/spendingSettings/main'), settings));
    await assertSucceeds(setDoc(doc(as(BOB), 'households/h1/spendingSettings/main'), { emailCheckedAt: 5, emailCheckedBy: BOB, updatedAt: 5, updatedBy: BOB }, { merge: true }));
    await assertSucceeds(getDoc(doc(as(BOB), 'households/h1/spendingSettings/main')));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/spendingSettings/main')));
    await assertFails(setDoc(doc(db, 'households/h1/spendingSettings/other'), settings));
    await assertFails(setDoc(doc(db, 'households/h1/spendingSettings/main'), { ...settings, monthlyBudget: -1 }));
    await assertFails(setDoc(doc(db, 'households/h1/spendingSettings/main'), { ...settings, theme: 'dark' }));
    await assertFails(deleteDoc(doc(db, 'households/h1/spendingSettings/main')));
  });

  it('lets members keep cards (with remembered statement columns) and category rules', async () => {
    const db = as(ALICE);
    const card = { name: 'Card One', last4: '1111', issuer: 'Example Bank', alertWords: ['alerts@bank.example.com'], createdAt: 1, by: ALICE };
    const csv = { date: 'Transaction Date', description: 'Description', amount: 'Amount', purchases: 'negative', dayFirst: false };
    await assertSucceeds(setDoc(doc(db, 'households/h1/spendingCards/c1'), card));
    await assertSucceeds(setDoc(doc(db, 'households/h1/spendingCards/c1'), { ...card, csv, updatedAt: 2 }));
    await assertFails(setDoc(doc(db, 'households/h1/spendingCards/c2'), { ...card, last4: '11' }));
    await assertFails(setDoc(doc(db, 'households/h1/spendingCards/c2'), { ...card, number: '4111111111111111' }));
    await assertFails(setDoc(doc(db, 'households/h1/spendingCards/c2'), { ...card, csv: { ...csv, purchases: 'sometimes' } }));
    await assertFails(setDoc(doc(as(MALLORY), 'households/h1/spendingCards/c3'), card));
    await assertSucceeds(deleteDoc(doc(db, 'households/h1/spendingCards/c1')));

    const rule = { contains: 'example cafe', category: 'Groceries', createdAt: 1, by: ALICE };
    await assertSucceeds(setDoc(doc(db, 'households/h1/spendingRules/r-example-cafe'), rule));
    await assertFails(setDoc(doc(db, 'households/h1/spendingRules/r-x'), { ...rule, contains: '' }));
    await assertFails(setDoc(doc(db, 'households/h1/spendingRules/r-x'), { ...rule, regex: '.*' }));
    await assertFails(getDocs(collection(as(MALLORY), 'households/h1/spendingRules')));
    await assertSucceeds(deleteDoc(doc(as(BOB), 'households/h1/spendingRules/r-example-cafe')));
  });
});

// Adversarial cases from the October 2026 security audit: each is an attack that must fail, or a
// boundary that must hold, written as the attacker would try it.
describe('attacks', () => {
  const now = () => Date.now();

  it('never lists households to someone who is not in them', async () => {
    const db = as(MALLORY);
    await assertFails(getDocs(query(collection(db, 'households'), where('members', 'array-contains', ALICE))));
    await assertFails(getDocs(collection(db, 'households')));
    await assertFails(getDocs(query(collection(db, 'households'), where('name', '==', 'Home'))));
  });

  it('refuses tokens without a verified email', async () => {
    const anonymous = env.authenticatedContext('anon', {}).firestore();
    await assertFails(getDoc(doc(anonymous, 'households/h1')));
    await assertFails(setDoc(doc(anonymous, 'households/h9'), { name: 'Mine', members: ['anon'], createdAt: now() }));
    await assertFails(setDoc(doc(as(MALLORY, false), 'households/h9'), { name: 'Mine', members: [MALLORY], createdAt: now() }));
    // Someone holding an unverified address cannot step into an invitation for it.
    await assertFails(getDoc(doc(as(BOB, false), 'households/h1')));
  });

  it('matches members by lowercase email, whatever case the token carries', async () => {
    await assertSucceeds(getDoc(doc(as('Alice@Example.COM'), 'households/h1')));
  });

  it('refuses a household backdated to look older than the ones its members already use', async () => {
    // Apps open the oldest household a person is in, so a backdated one would be picked first.
    await assertFails(setDoc(doc(as(MALLORY), 'households/h2'), { name: 'Home', members: [MALLORY], createdAt: 0 }));
    await assertFails(setDoc(doc(as(MALLORY), 'households/h2'), { name: 'Home', members: [MALLORY], createdAt: now() - 86400000 }));
    await assertFails(setDoc(doc(as(MALLORY), 'households/h2'), { name: 'Home', members: [MALLORY], createdAt: now() + 86400000 }));
    await assertSucceeds(setDoc(doc(as(MALLORY), 'households/h2'), { name: 'Home', members: [MALLORY], createdAt: now() }));
    await assertFails(updateDoc(doc(as(MALLORY), 'households/h2'), { createdAt: 0 }));
    await assertFails(updateDoc(doc(as(ALICE), 'households/h1'), { createdAt: 0 }));
  });

  it('refuses taking over an existing household id', async () => {
    await assertFails(setDoc(doc(as(MALLORY), 'households/h1'), { name: 'Mine', members: [MALLORY], createdAt: now() }));
  });

  it('keeps the members a list of lowercase emails', async () => {
    const h1 = doc(as(ALICE), 'households/h1');
    await assertFails(updateDoc(h1, { members: { [BOB]: true } }));
    await assertFails(updateDoc(h1, { members: [ALICE, BOB, 'Carol@Example.com'] }));
    await assertFails(updateDoc(h1, { members: [ALICE, BOB, 7] }));
    await assertFails(updateDoc(h1, { members: [ALICE, BOB, 'x'.repeat(255)] }));
    await assertFails(updateDoc(h1, { name: 'x'.repeat(101) }));
    await assertFails(updateDoc(h1, { name: 7 }));
    await assertSucceeds(updateDoc(h1, { members: arrayUnion('carol@example.com'), name: 'Our home' }));
  });

  it('refuses a creation batch that slips someone into another household', async () => {
    const db = as(MALLORY);
    const batch = writeBatch(db);
    batch.update(doc(db, 'households/h1'), { members: arrayUnion(MALLORY) });
    batch.set(doc(db, 'households/h1/lists/sneaky'), { name: 'Sneaky' });
    await assertFails(batch.commit());
  });

  it('allows no collection-group reads across households', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'households/h2'), { name: 'Other', members: [MALLORY], createdAt: 1 });
      await setDoc(doc(db, 'households/h2/reminders/r1'), { title: 'x', sent: false, at: 1 });
    });
    const db = as(ALICE);
    for (const group of ['reminders', 'agenda', 'pushSubscriptions', 'profiles', 'contacts', 'spendingTransactions', 'items']) {
      await assertFails(getDocs(collectionGroup(db, group)));
    }
  });

  it("refuses another household's data to a member of a different household", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'households/h2'), { name: 'Other', members: [MALLORY], createdAt: 1 });
    });
    const db = as(MALLORY);
    await assertFails(getDoc(doc(db, 'households/h1/items/i1')));
    await assertFails(setDoc(doc(db, 'households/h1/reminders/r1'), {
      app: 'pet', title: 'Hi', body: '', at: 1, url: 'https://example.com', recipients: 'all', sent: false, createdAt: 1, by: MALLORY,
    }));
    await assertFails(setDoc(doc(db, 'households/h1/pushSubscriptions/s1'), {
      email: MALLORY, app: 'pet', endpoint: 'https://push.example.com/x', keys: { p256dh: 'k', auth: 'a' }, createdAt: 1,
    }));
  });

  it('keeps contact links to web addresses', async () => {
    const vet = { name: 'Example Vet', apps: ['pet'], createdAt: 1, by: ALICE };
    const fails = (extra: Record<string, unknown>) => assertFails(setDoc(doc(as(ALICE), 'households/h1/contacts/c9'), { ...vet, ...extra }));
    await fails({ website: 'javascript:alert(document.cookie)' });
    await fails({ website: 'data:text/html,<script>alert(1)</script>' });
    await fails({ mapsUrl: 'javascript:alert(1)' });
    await fails({ website: 'https://example.com/' + 'x'.repeat(300) });
    await fails({ phone: 'x'.repeat(41) });
    await fails({ email: 'x'.repeat(121) });
    await fails({ role: 'x'.repeat(61) });
    await fails({ apps: [{ html: '<b>' }] });
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/contacts/c9'), {
      ...vet, website: 'https://example.com', mapsUrl: 'https://maps.google.com/?q=x', phone: '+1 555 0100', email: 'vet@example.com', role: 'Vet',
    }));
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/contacts/c10'), { ...vet, website: 'http://example.com' }));
  });

  it('keeps list item and baby appointment links to web addresses', async () => {
    const item = { name: 'Dentist', listId: 'todo', completed: false };
    const put = (data: Record<string, unknown>) => setDoc(doc(as(ALICE), 'households/h1/items/l1'), { ...item, ...data });
    await assertFails(put({ link: 'javascript:alert(1)' }));
    await assertFails(put({ link: 'data:text/html,<script>alert(1)</script>' }));
    await assertFails(put({ link: 'intent://evil#Intent;end' }));
    await assertFails(put({ link: 7 }));
    await assertSucceeds(put({ link: 'https://calendar.google.com/calendar/event?eid=abc' }));
    await assertSucceeds(put({ link: 'http://example.com' }));
    await assertSucceeds(put({ link: '' }));
    const visit = { title: 'Checkup', at: 1 };
    const appt = (data: Record<string, unknown>) => setDoc(doc(as(ALICE), 'households/h1/babyAppointments/a1'), { ...visit, ...data });
    await assertFails(appt({ calendarLink: 'javascript:alert(1)' }));
    await assertFails(appt({ calendarLink: 'http://calendar.example.com' }));
    await assertSucceeds(appt({ calendarLink: 'https://calendar.google.com/calendar/event?eid=abc' }));
  });

  it('keeps pet photos to image data', async () => {
    const photo = (data: string) => setDoc(doc(as(ALICE), 'households/h1/petPhotos/p1'), { data, updatedAt: 1, by: ALICE });
    await assertFails(photo('data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+'));
    await assertFails(photo('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='));
    await assertFails(photo('javascript:alert(1)//data:image/jpeg;base64,'));
    await assertFails(photo('data:image/jpeg;base64,"><script>alert(1)</script>'));
    await assertSucceeds(photo('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=='));
  });
});
