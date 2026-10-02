import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { arrayUnion, collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const MALLORY = 'mallory@example.com';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-huishouden-tasks',
    firestore: {
      rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
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
    await assertSucceeds(setDoc(doc(as(MALLORY), 'households/h2'), { name: 'Mine', members: [MALLORY], createdAt: 5 }));
  });

  it('allows creating a household and its default lists in one batch', async () => {
    const db = as(MALLORY);
    const batch = writeBatch(db);
    batch.set(doc(db, 'households/h3'), { name: 'Mine', members: [MALLORY], createdAt: 5 });
    batch.set(doc(db, 'households/h3/lists/groceries'), { name: 'Groceries' });
    await assertSucceeds(batch.commit());
  });

  it('blocks creating a household that adds someone else', async () => {
    await assertFails(setDoc(doc(as(MALLORY), 'households/h2'), { name: 'Mine', members: [MALLORY, ALICE], createdAt: 5 }));
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

  it('lets members read spending transactions that no browser can write', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'households/h1/spendingTransactions/t1'), { amount: 12.5, merchant: 'Corner Grocer' });
    });
    await assertSucceeds(getDoc(doc(as(ALICE), 'households/h1/spendingTransactions/t1')));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/spendingTransactions/t1')));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/spendingTransactions/t2'), { amount: 1 }));
    await assertFails(deleteDoc(doc(as(ALICE), 'households/h1/spendingTransactions/t1')));
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
