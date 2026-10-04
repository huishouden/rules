import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { arrayRemove, arrayUnion, collection, deleteDoc, deleteField, doc, getDoc, getDocs, query, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';

// One household with every role: Alice created it (admin by being first), Bob is a member by
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
const h1 = (db = as(ALICE)) => doc(db, 'households/h1');

describe('household roles', () => {
  it('makes the creator the admin, with or without a written role', async () => {
    await assertSucceeds(setDoc(doc(as(MALLORY), 'households/h2'), { name: 'Mine', members: [MALLORY], createdAt: Date.now() }));
    await assertSucceeds(updateDoc(doc(as(MALLORY), 'households/h2'), { members: arrayUnion(BOB) }));
    await assertSucceeds(setDoc(doc(as(MALLORY), 'households/h3'), { name: 'Mine', members: [MALLORY], roles: { [MALLORY]: 'admin' }, createdAt: Date.now() }));
    await assertSucceeds(updateDoc(doc(as(MALLORY), 'households/h3'), { members: arrayUnion(BOB), roles: { [MALLORY]: 'admin', [BOB]: 'helper' } }));
  });

  it('refuses a new household that gives its creator anything but admin, or names anyone else', async () => {
    const make = (roles: unknown) => setDoc(doc(as(MALLORY), 'households/h2'), { name: 'Mine', members: [MALLORY], roles, createdAt: Date.now() });
    await assertFails(make({ [MALLORY]: 'member' }));
    await assertFails(make({ [MALLORY]: 'admin', [ALICE]: 'admin' }));
    await assertFails(make('admin'));
  });

  it('lets only admins invite, and sets the invitee a role in the same write', async () => {
    await assertSucceeds(updateDoc(h1(), { members: arrayUnion('carol@example.com'), roles: { ...ROLES, 'carol@example.com': 'helper' } }));
    for (const who of ['member', 'helper', 'kid', 'outsider'] as Who[]) {
      await assertFails(updateDoc(h1(as(PERSON[who])), { members: arrayUnion('dave@example.com') }));
    }
  });

  it('lets only admins remove people, never themselves (security finding L2)', async () => {
    for (const who of ['member', 'helper', 'kid'] as Who[]) {
      await assertFails(updateDoc(h1(as(PERSON[who])), { members: arrayRemove(ALICE) }));
      await assertFails(updateDoc(h1(as(PERSON[who])), { members: arrayRemove(BOB) }));
    }
    await assertFails(updateDoc(h1(), { members: arrayRemove(ALICE) }));
    await assertSucceeds(updateDoc(h1(), { members: arrayRemove(BOB) }));
    // A removed helper's role goes with them; roles may only name members.
    await assertFails(updateDoc(h1(), { members: arrayRemove(HELEN) }));
    await assertSucceeds(updateDoc(h1(), { members: arrayRemove(HELEN), roles: { [HANK]: 'helper', [KIM]: 'kid' } }));
  });

  it('lets admins change anyone else’s role, to one of the four', async () => {
    await assertSucceeds(updateDoc(h1(), { roles: { ...ROLES, [BOB]: 'admin' } }));
    await assertSucceeds(updateDoc(h1(as(BOB)), { roles: { ...ROLES, [BOB]: 'admin', [HELEN]: 'member' } }));
    await assertFails(updateDoc(h1(), { roles: { ...ROLES, [BOB]: 'owner' } }));
    await assertFails(updateDoc(h1(), { roles: { ...ROLES, [BOB]: 1 } }));
    await assertFails(updateDoc(h1(), { roles: [ALICE] }));
  });

  it('never lets anyone change their own role', async () => {
    await assertFails(updateDoc(h1(as(BOB)), { roles: { ...ROLES, [BOB]: 'admin' } }));
    await assertFails(updateDoc(h1(as(HELEN)), { roles: { ...ROLES, [HELEN]: 'member' } }));
    await assertFails(updateDoc(h1(as(KIM)), { roles: { ...ROLES, [KIM]: 'helper' } }));
    // An admin can't step down either, so every household keeps an admin.
    await assertFails(updateDoc(h1(), { roles: { ...ROLES, [ALICE]: 'member' } }));
  });

  it('lets a second admin demote or remove the creator, writing out who is first', async () => {
    await seed('households/h1', { name: 'Home', members: MEMBERS, roles: { ...ROLES, [BOB]: 'admin' }, createdAt: 1 });
    await assertSucceeds(updateDoc(h1(as(BOB)), { roles: { ...ROLES, [BOB]: 'admin', [ALICE]: 'member' } }));
    await seed('households/h1', { name: 'Home', members: MEMBERS, roles: { ...ROLES, [BOB]: 'admin' }, createdAt: 1 });
    // Bob becomes first in the list, with his role written out, so he doesn't become admin by position alone.
    await assertSucceeds(updateDoc(h1(as(BOB)), { members: arrayRemove(ALICE) }));
  });

  it('never makes someone admin by moving them to the front of the list', async () => {
    await assertFails(updateDoc(h1(), { members: [HELEN, ALICE, BOB, HANK, KIM], roles: { [HANK]: 'helper', [KIM]: 'kid' } }));
    await seed('households/h1', { name: 'Home', members: MEMBERS, roles: { ...ROLES, [BOB]: 'admin' }, createdAt: 1 });
    await assertFails(updateDoc(h1(as(BOB)), { members: [HELEN, BOB, HANK, KIM], roles: { [BOB]: 'admin', [HANK]: 'helper', [KIM]: 'kid' } }));
    await assertSucceeds(updateDoc(h1(as(BOB)), { members: [HELEN, BOB, HANK, KIM], roles: { [BOB]: 'admin', [HELEN]: 'helper', [HANK]: 'helper', [KIM]: 'kid' } }));
  });

  it('lets admins and members rename the household; helpers and kids can’t', async () => {
    for (const who of EVERYONE) await expect(STAFF.includes(who), updateDoc(h1(as(PERSON[who])), { name: `Home of ${who}` }));
  });

  it('lets admins and members set the currency, a three-letter code; helpers and kids can’t', async () => {
    for (const who of EVERYONE) await expect(STAFF.includes(who), updateDoc(h1(as(PERSON[who])), { currency: 'EUR' }));
    await assertSucceeds(updateDoc(h1(as(BOB)), { name: 'Ours', currency: 'MXN' }));
    for (const bad of ['eur', 'EURO', 'E1R', 12, '']) await assertFails(updateDoc(h1(as(ALICE)), { currency: bad }));
    await assertFails(updateDoc(h1(as(BOB)), { currency: 'EUR', members: arrayUnion('carol@example.com') }));
  });

  it('lets a member rename but not touch members or roles in the same write', async () => {
    await assertFails(updateDoc(h1(as(BOB)), { name: 'Ours', members: arrayUnion('carol@example.com') }));
    await assertFails(updateDoc(h1(as(BOB)), { name: 'Ours', roles: { ...ROLES, [HELEN]: 'member' } }));
  });

  it('lets everyone in the household see it and record their own first sign-in', async () => {
    await seed('households/h1', { name: 'Home', members: MEMBERS, roles: ROLES, createdAt: 1 });
    for (const who of IN_HOUSEHOLD) {
      await assertSucceeds(getDoc(h1(as(PERSON[who]))));
      await assertSucceeds(updateDoc(h1(as(PERSON[who])), { joined: arrayUnion(PERSON[who]) }));
    }
    await assertFails(getDoc(h1(as(MALLORY))));
  });
});

/**
 * Everyday records: every role reads them, adds their own, and ticks anyone's; admins and members
 * change and remove anything; helpers and kids change and remove only what they added.
 */
interface Shared {
  col: string;
  doc: (by: string) => Record<string, unknown>;
  /** A change only admins, members or the record's author may make. */
  edit: Record<string, unknown>;
  /** Checking it off: anyone in the household. */
  tick?: Record<string, unknown>;
  /** Who may add one (default: everyone in the household). */
  adders?: Who[];
  /** Who may tick off someone else's (default: everyone in the household). */
  tickers?: Who[];
}

const SHARED: Shared[] = [
  {
    col: 'items',
    doc: (by) => ({ name: 'Milk', listId: 'groceries', completed: false, addedBy: 'Someone', by }),
    edit: { name: 'Oat milk' },
    tick: { completed: true, completedAt: 5, updatedAt: 5 },
  },
  {
    col: 'babyEvents',
    doc: (by) => ({ kind: 'sleep', at: 1700000000000, side: 'left', by, createdAt: 1 }),
    edit: { side: 'right' },
    // Ending a sleep someone else started.
    tick: { endAt: 1700003600000, updatedAt: 5 },
  },
  {
    col: 'babyChecklists',
    doc: (by) => ({ list: 'Bag', text: 'Charger', done: false, order: 1, createdAt: 1, by }),
    edit: { text: 'Phone charger' },
    tick: { done: true },
  },
  {
    col: 'carServiceItems',
    doc: (by) => ({ vehicleId: 'v1', name: 'Oil change', everyMonths: 6, createdAt: 1, by }),
    edit: { name: 'Oil and filter' },
    tick: { lastDate: '2031-05-01', lastOdometer: 1200, updatedAt: 5 },
  },
  { col: 'carOdometer', doc: (by) => ({ vehicleId: 'v1', date: '2031-05-01', reading: 1200, createdAt: 1, by }), edit: { reading: 1300 } },
  {
    col: 'carRenewals',
    doc: (by) => ({ vehicleId: 'v1', kind: 'registration', name: 'Registration', dueDate: '2031-05-01', everyMonths: 12, createdAt: 1, by }),
    edit: { name: 'Plates' },
    tick: { dueDate: '2032-05-01', updatedAt: 5 },
  },
  { col: 'carServiceLog', doc: (by) => ({ vehicleId: 'v1', date: '2031-05-01', what: 'Oil change', createdAt: 1, by }), edit: { what: 'Tyres' } },
  {
    col: 'homeTasks',
    doc: (by) => ({ title: 'Change filter', category: 'hvac', schedule: { kind: 'after-done', every: 3, unit: 'month' }, due: '2031-05-01', createdAt: 1, by }),
    edit: { title: 'Change the filter' },
    tick: { due: '2031-08-01', lastDone: '2031-05-01', updatedAt: 5 },
  },
  { col: 'homeServiceLog', doc: (by) => ({ date: '2031-05-01', title: 'Filter changed', createdAt: 1, by }), edit: { title: 'Filters' } },
  { col: 'homeWarranties', doc: (by) => ({ item: 'Fridge', createdAt: 1, by }), edit: { item: 'Freezer' } },
  {
    col: 'homeEvents',
    doc: (by) => ({ title: 'Garbage pickup', kind: 'trash', rule: { freq: 'week', every: 1, start: '2031-01-02' }, createdAt: 1, by }),
    edit: { exceptions: { '2031-12-25': { moved: { date: '2031-12-26' } } } },
  },
  { col: 'petProfiles', doc: (by) => ({ name: 'Biscuit', species: 'dog', weightUnit: 'lb', createdAt: 1, by }), edit: { name: 'Biscuit II' } },
  {
    col: 'petReminders',
    doc: (by) => ({ petId: 'p1', kind: 'flea-tick', title: 'Flea and tick', every: 1, unit: 'month', due: '2031-05-12', createdAt: 1, by }),
    edit: { title: 'Fleas' },
    tick: { lastDoneAt: 5, due: '2031-06-12', updatedAt: 5 },
    // Ticking off a medicine reminder records it given: never a kid.
    tickers: ['admin', 'member', 'helper'],
  },
  { col: 'petWeights', doc: (by) => ({ petId: 'p1', at: 1700000000000, value: 26.1, unit: 'lb', by, createdAt: 1 }), edit: { value: 27 } },
  { col: 'petRecords', doc: (by) => ({ petId: 'p1', title: 'Allergy test', date: '2030-11-14', createdAt: 1, by }), edit: { title: 'Allergies' } },
  { col: 'petMeals', doc: (by) => ({ petId: 'p1', name: 'AM', time: '09:00', createdAt: 1, by }), edit: { time: '08:00' } },
  { col: 'petFeedings', doc: (by) => ({ petId: 'p1', mealId: 'p1-am', at: 1700000000000, by, createdAt: 1 }), edit: { portion: 'Half' } },
  { col: 'petPhotos', doc: (by) => ({ data: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==', updatedAt: 1, by }), edit: { data: 'data:image/jpeg;base64,/9j/4AAQ' } },
  {
    col: 'petDoses',
    doc: (by) => ({ petId: 'p1', reminderId: 'r1', title: 'Flea and tick', at: 1700000000000, by, createdAt: 1 }),
    edit: { at: 1700000001000 },
    adders: ['admin', 'member', 'helper'],
  },
  // Private-capable records, written open (`private: false`).
  { col: 'contacts', doc: (by) => ({ name: 'Example Vet', apps: ['pet'], private: false, createdAt: 1, by }), edit: { name: 'Example Clinic' } },
  { col: 'babyAppointments', doc: (by) => ({ title: 'Checkup', at: 1700000000000, private: false, createdAt: 1, by }), edit: { title: 'Weigh-in' } },
  { col: 'carAppointments', doc: (by) => ({ vehicleId: 'v1', title: 'Service', at: 1700000000000, private: false, createdAt: 1, by }), edit: { title: 'MOT' } },
  { col: 'petAppointments', doc: (by) => ({ petIds: ['p1'], kind: 'vet', title: 'Vet', at: 1700000000000, private: false, createdAt: 1, by }), edit: { title: 'Jabs' } },
];

describe('everyday records, by role', () => {
  for (const s of SHARED) {
    describe(s.col, () => {
      const adders = s.adders ?? IN_HOUSEHOLD;
      const theirs = `households/h1/${s.col}/theirs`;
      beforeEach(() => seed(theirs, s.doc(ALICE)));

      for (const who of EVERYONE) {
        const me = PERSON[who];
        const staff = STAFF.includes(who);
        const inside = IN_HOUSEHOLD.includes(who);
        const adds = adders.includes(who);

        it(`${who}: reads ${inside ? 'them' : 'nothing'}`, async () => {
          await expect(inside, getDoc(doc(as(me), theirs)));
          await expect(inside, getDocs(query(collection(as(me), `households/h1/${s.col}`), where('private', '==', false))));
        });

        it(`${who}: ${adds ? 'adds' : 'can’t add'} their own${adds ? ', and changes and removes it' : ''}`, async () => {
          const mine = doc(as(me), `households/h1/${s.col}/mine-${who}`);
          await expect(adds, setDoc(mine, s.doc(me)));
          if (!adds) return;
          await assertSucceeds(updateDoc(mine, s.edit));
          await assertSucceeds(deleteDoc(mine));
        });

        it(`${who}: ${staff ? 'adds in another’s name' : 'can’t add in another’s name'}`, async () => {
          await expect(staff, setDoc(doc(as(me), `households/h1/${s.col}/forged-${who}`), s.doc(ALICE)));
        });

        it(`${who}: ${staff ? 'changes and removes' : 'can’t change or remove'} someone else’s`, async () => {
          await expect(staff, updateDoc(doc(as(me), theirs), s.edit));
          await expect(staff, updateDoc(doc(as(me), theirs), { by: me }));
          await expect(staff, setDoc(doc(as(me), theirs), s.doc(me)));
          await expect(staff, deleteDoc(doc(as(me), theirs)));
        });

        if (s.tick) {
          const ticks = (s.tickers ?? IN_HOUSEHOLD).includes(who);
          it(`${who}: ${ticks ? 'ticks off' : 'can’t tick off'} someone else’s`, async () => {
            await expect(ticks, updateDoc(doc(as(me), theirs), s.tick!));
          });
        }
      }
    });
  }
});

describe("a contact's pay details", () => {
  const landlord = (by: string) => ({ name: 'Example Rentals', apps: ['bills'], private: false, createdAt: 1, by });
  const pay = (by: string) => ({ zelle: '(555) 010-2231', updatedAt: 1, by });

  for (const who of EVERYONE) {
    const me = PERSON[who];
    const staff = STAFF.includes(who);
    it(`${who}: ${staff ? 'reads, adds, changes and deletes' : 'can’t read, add, change or delete'} pay details`, async () => {
      await seed('households/h1/contacts/landlord', landlord(ALICE));
      await seed('households/h1/contactPay/landlord', pay(ALICE));
      await expect(staff, getDoc(doc(as(me), 'households/h1/contactPay/landlord')));
      await expect(staff, getDocs(collection(as(me), 'households/h1/contactPay')));
      await expect(staff, setDoc(doc(as(me), 'households/h1/contactPay/landlord'), { venmo: '@example-rentals', updatedAt: 2, by: me }, { merge: true }));
      await seed(`households/h1/contacts/mine-${who}`, landlord(me));
      await expect(staff, setDoc(doc(as(me), `households/h1/contactPay/mine-${who}`), pay(me)));
      await expect(staff, deleteDoc(doc(as(me), 'households/h1/contactPay/landlord')));
    });
  }

  for (const who of IN_HOUSEHOLD) {
    const me = PERSON[who];
    it(`${who}: edits and deletes their own contact without touching its pay details`, async () => {
      const mine = `households/h1/contacts/own-${who}`;
      await seed(mine, landlord(me));
      await seed(`households/h1/contactPay/own-${who}`, pay(ALICE));
      await assertSucceeds(updateDoc(doc(as(me), mine), { name: 'Example Rentals LLC', updatedAt: 2 }));
      await assertFails(updateDoc(doc(as(me), mine), { pay: { zelle: 'rent@example.com' } }));
      await assertSucceeds(deleteDoc(doc(as(me), mine)));
    });
  }

  it('an admin removes pay details left on a contact (moving them to contactPay) and those of a deleted contact', async () => {
    await seed('households/h1/contacts/old', { ...landlord(BOB), pay: { zelle: 'old@example.com' } });
    await seed('households/h1/contactPay/gone', pay(BOB));
    const db = as(ALICE);
    const batch = writeBatch(db);
    batch.set(doc(db, 'households/h1/contactPay/old'), { zelle: 'old@example.com', updatedAt: 3, by: ALICE });
    batch.update(doc(db, 'households/h1/contacts/old'), { pay: deleteField() });
    batch.delete(doc(db, 'households/h1/contactPay/gone'));
    await assertSucceeds(batch.commit());
    // A helper can't do the same.
    await seed('households/h1/contacts/old2', { ...landlord(HELEN), pay: { zelle: 'old@example.com' } });
    await assertFails(setDoc(doc(as(HELEN), 'households/h1/contactPay/old2'), { zelle: 'old@example.com', by: HELEN }));
  });
});

describe('private contacts and appointments', () => {
  const PRIVATE = SHARED.filter((s) => ['contacts', 'babyAppointments', 'carAppointments', 'petAppointments'].includes(s.col));

  for (const s of PRIVATE) {
    describe(s.col, () => {
      const secret = `households/h1/${s.col}/secret`;
      const legacy = `households/h1/${s.col}/legacy`;
      beforeEach(async () => {
        await seed(secret, { ...s.doc(ALICE), private: true });
        const { private: _p, ...old } = s.doc(ALICE);
        await seed(legacy, old);
      });

      for (const who of EVERYONE) {
        const me = PERSON[who];
        const staff = STAFF.includes(who);

        it(`${who}: ${staff ? 'reads' : 'can’t read'} private ones, or ones written before roles`, async () => {
          await expect(staff, getDoc(doc(as(me), secret)));
          await expect(staff, getDoc(doc(as(me), legacy)));
          // Helpers' and kids' lists ask only for open records; asking for everything is refused.
          await expect(staff, getDocs(collection(as(me), `households/h1/${s.col}`)));
        });

        it(`${who}: ${staff ? 'adds' : 'can’t add'} a private one`, async () => {
          await expect(staff, setDoc(doc(as(me), `households/h1/${s.col}/p-${who}`), { ...s.doc(me), private: true }));
        });
      }

      it('requires helpers and kids to say a record is open, and keeps the flag a boolean', async () => {
        const { private: _p, ...unflagged } = s.doc(HELEN);
        await assertFails(setDoc(doc(as(HELEN), `households/h1/${s.col}/n1`), unflagged));
        await assertFails(setDoc(doc(as(ALICE), `households/h1/${s.col}/n2`), { ...s.doc(ALICE), private: 'yes' }));
        await assertSucceeds(setDoc(doc(as(ALICE), `households/h1/${s.col}/n3`), unflagged));
      });

      it('stops a helper changing or removing their own record once it is made private', async () => {
        await seed(`households/h1/${s.col}/hers`, { ...s.doc(HELEN), private: true });
        await assertFails(updateDoc(doc(as(HELEN), `households/h1/${s.col}/hers`), { private: false }));
        await assertFails(setDoc(doc(as(HELEN), `households/h1/${s.col}/hers`), s.doc(HELEN)));
        await assertFails(deleteDoc(doc(as(HELEN), `households/h1/${s.col}/hers`)));
      });

      it('stops a helper making their own record private', async () => {
        await seed(`households/h1/${s.col}/hers`, s.doc(HELEN));
        await assertFails(updateDoc(doc(as(HELEN), `households/h1/${s.col}/hers`), { private: true }));
      });
    });
  }
});

/** The household's setup and choices: everyone reads, admins and members write. */
const SETUP: { path: string; doc: Record<string, unknown>; create?: boolean }[] = [
  { path: 'lists/groceries', doc: { name: 'Groceries' } },
  { path: 'stores/s1', doc: { name: 'Corner Grocer', categoryOrder: [] } },
  { path: 'carVehicles/v1', doc: { name: 'The car', createdAt: 1, by: ALICE } },
  { path: 'carSettings/main', doc: { distanceUnit: 'km', updatedAt: 1, updatedBy: ALICE } },
  { path: 'babyProfile/main', doc: { name: 'Baby', updatedAt: 1 } },
  {
    path: 'petMedCourses/k1',
    doc: { petId: 'p1', name: 'Antibiotic', dose: '1 tablet', timesPerDay: 1, times: ['09:00'], startDate: '2031-05-12', days: 7, withFood: true, createdAt: 1, by: ALICE },
  },
  { path: 'settings/portal', doc: { order: ['pet'], hidden: [], updatedAt: 1, by: ALICE } },
  { path: 'settings/food', doc: { people: [], pantryAssumed: ['salt'], updatedAt: 1, by: '' } },
  { path: 'favorites/steak', doc: { meal: { name: 'Steak' }, savedAt: 1, savedBy: 'Alice' } },
  { path: 'menus/m1', doc: { meals: [], createdAt: 1 }, create: true },
  { path: 'mealPlan/2031-01-06_dinner', doc: { day: '2031-01-06', type: 'dinner', name: 'Soup', meal: {}, by: '', updatedAt: 1 } },
];

describe('household setup, by role', () => {
  for (const s of SETUP) {
    describe(s.path.split('/')[0] + (s.path.startsWith('settings') ? `/${s.path.split('/')[1]}` : ''), () => {
      const path = `households/h1/${s.path}`;
      beforeEach(() => seed(path, s.doc));

      for (const who of EVERYONE) {
        const me = PERSON[who];
        const staff = STAFF.includes(who);
        const inside = IN_HOUSEHOLD.includes(who);
        // Food preferences and the meal plan record who wrote them.
        const signed = { ...s.doc, ...('by' in s.doc && typeof s.doc.by === 'string' && s.path.match(/^(settings\/food|mealPlan)/) ? { by: me } : {}) };

        it(`${who}: ${inside ? 'reads' : 'can’t read'}, ${staff ? 'writes' : 'can’t write'}`, async () => {
          await expect(inside, getDoc(doc(as(me), path)));
          if (s.create) {
            await expect(staff, setDoc(doc(as(me), `${path}-${who}`), signed));
          } else {
            await expect(staff, setDoc(doc(as(me), path), signed));
          }
          // Settings documents are never deleted, only changed.
          await expect(staff && !/^(settings|carSettings|babyProfile)\//.test(s.path), deleteDoc(doc(as(me), path)));
        });
      }
    });
  }
});

/** Spending and Bills: admins and members only; helpers and kids can't even read them. */
const MONEY: { path: string; doc: (me: string) => Record<string, unknown> }[] = [
  {
    path: 'spendingTransactions/t1',
    doc: (by) => ({ date: '2031-03-14', description: 'EXAMPLE GROCERY', amount: 61.15, category: 'Groceries', card: 'Card One', type: 'Sale', source: 'statement', createdAt: 1, by }),
  },
  { path: 'spendingSettings/main', doc: (by) => ({ monthlyBudget: 100, updatedAt: 1, updatedBy: by }) },
  { path: 'spendingCards/c1', doc: (by) => ({ name: 'Card One', alertWords: [], createdAt: 1, by }) },
  { path: 'spendingRules/r1', doc: (by) => ({ contains: 'GROCERY', category: 'Groceries', createdAt: 1, by }) },
  { path: 'billSources/power', doc: (by) => ({ name: 'Example Power Co', kind: 'electric', from: 'billing@power.example.com', autopay: null, createdAt: 1, createdBy: by, updatedAt: 1 }) },
  { path: 'billSuggestions/netflix', doc: (by) => ({ status: 'dismissed', name: 'Netflix', by, at: 1 }) },
  {
    path: 'bills/b1',
    doc: (by) => ({ schema: 'bill/v1', source: 'manual', kind: 'electric', label: 'Power', due: '2031-05-20', amountDue: { amount: '120.00', currency: 'USD' }, status: 'due', autopay: null, createdAt: 1, createdBy: by, updatedAt: 1 }),
  },
];

describe('money, by role', () => {
  for (const m of MONEY) {
    describe(m.path.split('/')[0], () => {
      const path = `households/h1/${m.path}`;
      const col = `households/h1/${m.path.split('/')[0]}`;
      beforeEach(() => seed(path, m.doc(ALICE)));

      for (const who of EVERYONE) {
        const me = PERSON[who];
        const staff = STAFF.includes(who);
        it(`${who}: ${staff ? 'reads and writes' : 'can’t read or write'}`, async () => {
          await expect(staff, getDoc(doc(as(me), path)));
          await expect(staff, getDocs(collection(as(me), col)));
          await expect(staff, setDoc(doc(as(me), path), m.doc(me)));
          if (!m.path.startsWith('spendingSettings')) await expect(staff, deleteDoc(doc(as(me), path)));
        });
      }
    });
  }

  it('keeps each member’s bill check to admins and members', async () => {
    const check = (by: string) => ({ checkedAt: 1, by, sources: 1, emails: 2, bills: 1, errors: [] });
    await assertSucceeds(setDoc(doc(as(BOB), `households/h1/billSync/${BOB}`), check(BOB)));
    await assertFails(setDoc(doc(as(HELEN), `households/h1/billSync/${HELEN}`), check(HELEN)));
    await assertFails(getDoc(doc(as(HELEN), `households/h1/billSync/${BOB}`)));
    await assertFails(getDoc(doc(as(KIM), `households/h1/billSync/${BOB}`)));
  });
});

describe('medicine', () => {
  const course = (extra: Record<string, unknown> = {}) => ({
    petId: 'p1', name: 'Antibiotic', dose: '1 tablet', timesPerDay: 2, times: ['09:00', '19:00'], startDate: '2031-05-12', days: 7, withFood: true, createdAt: 1, by: ALICE, ...extra,
  });
  const dose = (courseId: string, by: string) => ({ petId: 'p1', courseId, slot: 0, at: 1700000000000, by, createdAt: 1 });
  const give = (who: string, courseId: string, id = `d-${who}-${courseId}`) => setDoc(doc(as(who), `households/h1/petMedDoses/${id}`), dose(courseId, who));

  beforeEach(async () => {
    await seed('households/h1/petMedCourses/open', course());
    await seed('households/h1/petMedCourses/all', course({ givers: 'all' }));
    await seed('households/h1/petMedCourses/approved', course({ givers: 'approved', approvedHelpers: [HELEN] }));
  });

  it('lets every helper give a course for all helpers (the default)', async () => {
    for (const who of [ALICE, BOB, HELEN, HANK]) {
      await assertSucceeds(give(who, 'open'));
      await assertSucceeds(give(who, 'all'));
    }
  });

  it('lets only approved helpers give a restricted course; admins and members always can', async () => {
    await assertSucceeds(give(ALICE, 'approved'));
    await assertSucceeds(give(BOB, 'approved'));
    await assertSucceeds(give(HELEN, 'approved'));
    await assertFails(give(HANK, 'approved'));
  });

  it('never lets a kid give medicine, of either kind', async () => {
    for (const id of ['open', 'all', 'approved']) await assertFails(give(KIM, id));
    await assertFails(setDoc(doc(as(KIM), 'households/h1/petDoses/kd'), { petId: 'p1', reminderId: 'r1', title: 'Flea and tick', at: 1, by: KIM, createdAt: 1 }));
  });

  it('refuses a helper a dose for a course that doesn’t exist, or moved onto a restricted one', async () => {
    await assertFails(give(HANK, 'missing'));
    await assertSucceeds(give(HANK, 'open', 'mine'));
    await assertFails(updateDoc(doc(as(HANK), 'households/h1/petMedDoses/mine'), { courseId: 'approved' }));
    await assertSucceeds(deleteDoc(doc(as(HANK), 'households/h1/petMedDoses/mine')));
  });

  it('lets a helper undo their own dose but not someone else’s', async () => {
    await seed('households/h1/petMedDoses/alices', dose('open', ALICE));
    await assertFails(deleteDoc(doc(as(HELEN), 'households/h1/petMedDoses/alices')));
    await assertSucceeds(give(HELEN, 'open', 'hers'));
    await assertSucceeds(deleteDoc(doc(as(HELEN), 'households/h1/petMedDoses/hers')));
  });

  it('lets only admins and members choose who gives a course', async () => {
    await assertSucceeds(setDoc(doc(as(BOB), 'households/h1/petMedCourses/k2'), course({ givers: 'approved', approvedHelpers: [HANK], by: BOB })));
    await assertFails(setDoc(doc(as(HANK), 'households/h1/petMedCourses/approved'), course({ givers: 'approved', approvedHelpers: [HELEN, HANK] })));
    await assertFails(updateDoc(doc(as(HANK), 'households/h1/petMedCourses/approved'), { givers: 'all' }));
    await assertFails(setDoc(doc(as(HELEN), 'households/h1/petMedCourses/k3'), course({ by: HELEN })));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/petMedCourses/k4'), course({ givers: 'some' })));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/petMedCourses/k5'), course({ givers: 'approved', approvedHelpers: ['Helen@Example.com'] })));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/petMedCourses/k6'), course({ approvedHelpers: 'helen@example.com' })));
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/petMedCourses/k7'), course({ givers: 'approved', approvedHelpers: [] })));
  });
});

describe('agenda and reminders', () => {
  const item = (by: string, extra: Record<string, unknown> = {}) => ({
    app: 'pet', ref: 'pet:feed', kind: 'feeding', title: 'Feed Biscuit', start: 1700000000000, allDay: false, url: 'https://huishouden-pet.web.app/', status: 'upcoming', private: false, updatedAt: 1, by, ...extra,
  });
  const reminder = (by: string, extra: Record<string, unknown> = {}) => ({
    app: 'pet', title: 'Give Biscuit his tablet', body: '', at: 1700000000000, url: 'https://huishouden-pet.web.app/', recipients: 'all', private: false, sent: false, createdAt: 1, by, ...extra,
  });

  for (const [col, make] of [['agenda', item], ['reminders', reminder]] as const) {
    describe(col, () => {
      beforeEach(async () => {
        await seed(`households/h1/${col}/open`, make(ALICE));
        await seed(`households/h1/${col}/secret`, make(ALICE, { private: true }));
        await seed(`households/h1/${col}/legacy`, (({ private: _p, ...rest }) => rest)(make(ALICE)));
        await seed(`households/h1/${col}/bill`, make(ALICE, { app: 'bills', private: true }));
      });

      it('lets helpers and kids read only open items, with a query that asks for them', async () => {
        for (const who of [HELEN, KIM]) {
          await assertSucceeds(getDoc(doc(as(who), `households/h1/${col}/open`)));
          await assertFails(getDoc(doc(as(who), `households/h1/${col}/secret`)));
          await assertFails(getDoc(doc(as(who), `households/h1/${col}/legacy`)));
          await assertFails(getDoc(doc(as(who), `households/h1/${col}/bill`)));
          await assertSucceeds(getDocs(query(collection(as(who), `households/h1/${col}`), where('private', '==', false))));
          await assertFails(getDocs(collection(as(who), `households/h1/${col}`)));
        }
        for (const who of [ALICE, BOB]) await assertSucceeds(getDocs(collection(as(who), `households/h1/${col}`)));
        await assertFails(getDocs(query(collection(as(MALLORY), `households/h1/${col}`), where('private', '==', false))));
      });

      it('lets helpers keep open items in step, even ones others wrote', async () => {
        await assertSucceeds(setDoc(doc(as(HELEN), `households/h1/${col}/open`), make(HELEN, { title: 'Fed Biscuit' })));
        await assertSucceeds(setDoc(doc(as(KIM), `households/h1/${col}/new`), make(KIM)));
        await assertSucceeds(deleteDoc(doc(as(HELEN), `households/h1/${col}/open`)));
      });

      it('keeps Spending’s and Bills’ items private, whoever writes them', async () => {
        await assertFails(setDoc(doc(as(BOB), `households/h1/${col}/b2`), make(BOB, { app: 'bills', private: false })));
        await assertFails(setDoc(doc(as(ALICE), `households/h1/${col}/b3`), make(ALICE, { app: 'spending', private: false })));
        await assertSucceeds(setDoc(doc(as(ALICE), `households/h1/${col}/b4`), (({ private: _p, ...rest }) => rest)(make(ALICE, { app: 'bills' }))));
        // An open one written some other way can't be taken over by a helper relabelling it.
        await seed(`households/h1/${col}/openbill`, make(ALICE, { app: 'bills', private: false }));
        await assertFails(setDoc(doc(as(HELEN), `households/h1/${col}/openbill`), make(HELEN)));
      });

      it('keeps a helper’s items signed by them and linking into the apps', async () => {
        await assertFails(setDoc(doc(as(HELEN), `households/h1/${col}/n5`), make(ALICE)));
        await assertFails(setDoc(doc(as(HELEN), `households/h1/${col}/n6`), make(HELEN, { url: 'https://evil.example.com/login' })));
        await assertFails(setDoc(doc(as(HELEN), `households/h1/${col}/open`), make(HELEN, { url: 'https://huishouden-pet.web.app.evil.example.com/' })));
        await assertSucceeds(setDoc(doc(as(HELEN), `households/h1/${col}/n7`), make(HELEN, { url: 'https://huishouden-staging-pet.web.app/pets/p1' })));
        await assertSucceeds(setDoc(doc(as(ALICE), `households/h1/${col}/n8`), make(ALICE, { url: 'https://example.com/' })));
      });

      it('never lets helpers write or remove private items, or Spending’s or Bills’', async () => {
        await assertFails(setDoc(doc(as(HELEN), `households/h1/${col}/secret`), make(HELEN)));
        await assertFails(setDoc(doc(as(HELEN), `households/h1/${col}/legacy`), make(HELEN)));
        await assertFails(deleteDoc(doc(as(HELEN), `households/h1/${col}/secret`)));
        await assertFails(deleteDoc(doc(as(HELEN), `households/h1/${col}/bill`)));
        await assertFails(setDoc(doc(as(HELEN), `households/h1/${col}/n1`), make(HELEN, { private: true })));
        await assertFails(setDoc(doc(as(HELEN), `households/h1/${col}/n2`), make(HELEN, { app: 'bills' })));
        await assertFails(setDoc(doc(as(HELEN), `households/h1/${col}/n3`), make(HELEN, { app: 'spending' })));
        await assertSucceeds(setDoc(doc(as(BOB), `households/h1/${col}/n4`), make(BOB, { app: 'bills', private: true })));
      });
    });
  }
});

describe('reminders already sent', () => {
  it('can’t be re-armed by a helper; admins and members may resend', async () => {
    const sent = { app: 'pet', title: 'Dose', body: '', at: 1, url: 'https://huishouden-pet.web.app/', recipients: 'all', private: false, sent: true, sentAt: 2, createdAt: 1, by: ALICE };
    await seed('households/h1/reminders/r1', sent);
    await assertFails(setDoc(doc(as(HELEN), 'households/h1/reminders/r1'), { ...sent, title: 'Dose now', sent: false, by: HELEN }));
    await assertSucceeds(setDoc(doc(as(HELEN), 'households/h1/reminders/r1'), { ...sent, by: HELEN }));
    await assertSucceeds(setDoc(doc(as(BOB), 'households/h1/reminders/r1'), { ...sent, sent: false, by: BOB }));
  });
});

describe('ticking off', () => {
  it('lets a kid tick off a reminder that isn’t medicine', async () => {
    const reminder = { petId: 'p1', kind: 'vaccine', title: 'Rabies', due: '2031-05-12', createdAt: 1, by: ALICE };
    await seed('households/h1/petReminders/r1', reminder);
    await assertSucceeds(updateDoc(doc(as(KIM), 'households/h1/petReminders/r1'), { lastDoneAt: 5, due: '2032-05-12', updatedAt: 5 }));
    await seed('households/h1/petReminders/r2', { ...reminder, kind: 'heartworm' });
    await assertFails(updateDoc(doc(as(KIM), 'households/h1/petReminders/r2'), { lastDoneAt: 5 }));
    await assertSucceeds(updateDoc(doc(as(HELEN), 'households/h1/petReminders/r2'), { lastDoneAt: 5 }));
  });

  it('lets a helper tick a step on someone else’s item but not add, drop or empty steps', async () => {
    const steps = [{ id: 's1', text: 'Pack', done: false }, { id: 's2', text: 'Go', done: false }];
    await seed('households/h1/items/c1', { name: 'Trip', listId: 'todo', completed: false, subtasks: steps, by: ALICE });
    const db = as(HELEN);
    await assertSucceeds(updateDoc(doc(db, 'households/h1/items/c1'), { subtasks: [{ ...steps[0], done: true }, steps[1]], updatedAt: 5 }));
    await assertFails(updateDoc(doc(db, 'households/h1/items/c1'), { subtasks: [] }));
    await assertFails(updateDoc(doc(db, 'households/h1/items/c1'), { subtasks: [...steps, { id: 's3', text: 'x', done: false }] }));
    await assertFails(updateDoc(doc(db, 'households/h1/items/c1'), { subtasks: 'xx' }));
    await assertSucceeds(updateDoc(doc(as(BOB), 'households/h1/items/c1'), { subtasks: [] }));
  });
});

describe('Home: things to do before a regular event', () => {
  const event = { title: 'Garbage pickup', kind: 'trash', rule: { freq: 'week', every: 1, start: '2031-01-02' }, createdAt: 1, by: ALICE };
  beforeEach(() => seed('households/h1/homeEvents/e1', event));

  for (const who of EVERYONE) {
    const me = PERSON[who];
    const inside = IN_HOUSEHOLD.includes(who);
    const staff = STAFF.includes(who);

    it(`${who}: ${inside ? 'ticks one off in their own name and undoes it' : 'can’t tick anything off'}`, async () => {
      const tick = doc(as(me), `households/h1/homeEventPrep/e1_2031-10-22-${who}`.replace(`-${who}`, ''));
      await expect(inside, setDoc(tick, { done: true, at: 5, by: me }));
      await expect(inside, getDoc(tick));
      if (!inside) return;
      await assertFails(setDoc(tick, { done: true, at: 5, by: who === 'admin' ? BOB : ALICE }));
      await assertSucceeds(deleteDoc(tick));
    });

    it(`${who}: ${staff ? 'undoes' : 'can’t undo'} someone else’s tick`, async () => {
      await seed('households/h1/homeEventPrep/e1_2031-10-29', { done: true, at: 5, by: who === 'admin' ? BOB : ALICE });
      await expect(staff, deleteDoc(doc(as(me), 'households/h1/homeEventPrep/e1_2031-10-29')));
    });
  }

  it('ticks only for an event that exists, with a day in the id, and nothing else in it', async () => {
    const db = as(HELEN);
    await assertFails(setDoc(doc(db, 'households/h1/homeEventPrep/gone_2031-10-22'), { done: true, at: 5, by: HELEN }));
    await assertFails(setDoc(doc(db, 'households/h1/homeEventPrep/e1'), { done: true, at: 5, by: HELEN }));
    await assertFails(setDoc(doc(db, 'households/h1/homeEventPrep/e1_next-week'), { done: true, at: 5, by: HELEN }));
    await assertFails(setDoc(doc(db, 'households/h1/homeEventPrep/e1_2031-10-22'), { done: false, at: 5, by: HELEN }));
    await assertFails(setDoc(doc(db, 'households/h1/homeEventPrep/e1_2031-10-22'), { done: true, at: '5', by: HELEN }));
    await assertFails(setDoc(doc(db, 'households/h1/homeEventPrep/e1_2031-10-22'), { done: true, at: 5, by: HELEN, note: 'x' }));
    await assertSucceeds(setDoc(doc(db, 'households/h1/homeEventPrep/e1_2031-10-22'), { done: true, at: 5, by: HELEN }));
  });

  it('lets a helper add their own event, but not move or skip one of someone else’s', async () => {
    const db = as(HELEN);
    await assertSucceeds(setDoc(doc(db, 'households/h1/homeEvents/mine'), { ...event, by: HELEN }));
    await assertFails(updateDoc(doc(db, 'households/h1/homeEvents/e1'), { exceptions: { '2031-10-23': { skipped: true } } }));
    await assertSucceeds(updateDoc(doc(as(BOB), 'households/h1/homeEvents/e1'), { exceptions: { '2031-10-23': { skipped: true } } }));
  });
});

describe('Tasks lists, staples and aisles', () => {
  it('lets every role keep staples and learned aisles as they add and tick items', async () => {
    await seed('households/h1/stores/s1', { name: 'Corner Grocer', categoryOrder: [] });
    for (const who of IN_HOUSEHOLD) {
      await assertSucceeds(setDoc(doc(as(PERSON[who]), 'households/h1/staples/milk'), { displayName: 'Milk', timesAdded: 1 }, { merge: true }));
      await assertSucceeds(setDoc(doc(as(PERSON[who]), 'households/h1/stores/s1/aisles/milk'), { aisle: '12', name: 'Milk', updatedAt: 1, updatedBy: 'x' }));
    }
    await assertFails(setDoc(doc(as(MALLORY), 'households/h1/staples/milk'), { displayName: 'Milk' }));
  });

  it('lets a household creator write the default lists in the creating batch', async () => {
    const db = as(MALLORY);
    const batch = writeBatch(db);
    batch.set(doc(db, 'households/h9'), { name: 'Mine', members: [MALLORY], roles: { [MALLORY]: 'admin' }, createdAt: Date.now() });
    batch.set(doc(db, 'households/h9/lists/groceries'), { name: 'Groceries' });
    await assertSucceeds(batch.commit());
  });
});

describe('role attacks', () => {
  it('a helper can’t promote themselves, by role or by position', async () => {
    await assertFails(updateDoc(h1(as(HELEN)), { roles: { ...ROLES, [HELEN]: 'admin' } }));
    await assertFails(updateDoc(h1(as(HELEN)), { roles: { [HANK]: 'helper', [KIM]: 'kid' } }));
    await assertFails(updateDoc(h1(as(HELEN)), { members: [HELEN, ALICE, BOB, HANK, KIM] }));
    await assertFails(updateDoc(h1(as(HELEN)), { members: arrayUnion('accomplice@example.com') }));
    await assertFails(updateDoc(h1(as(HELEN)), { joined: arrayUnion(HELEN), roles: {} }));
  });

  it('a kid can’t promote another kid or helper', async () => {
    await assertFails(updateDoc(h1(as(KIM)), { roles: { ...ROLES, [HANK]: 'admin' } }));
  });

  it('a member can’t remove the creator or another member', async () => {
    await assertFails(updateDoc(h1(as(BOB)), { members: arrayRemove(ALICE) }));
    await assertFails(updateDoc(h1(as(BOB)), { members: [BOB, HELEN, HANK, KIM] }));
  });

  it('a helper can’t delete others’ items, even in a batch with their own', async () => {
    await seed('households/h1/items/alices', { name: 'Milk', listId: 'groceries', completed: false, by: ALICE });
    await seed('households/h1/items/legacy', { name: 'Bread', listId: 'groceries', completed: false });
    await assertSucceeds(setDoc(doc(as(HELEN), 'households/h1/items/hers'), { name: 'Juice', listId: 'groceries', completed: false, by: HELEN }));
    const db = as(HELEN);
    const batch = writeBatch(db);
    batch.delete(doc(db, 'households/h1/items/hers'));
    batch.delete(doc(db, 'households/h1/items/alices'));
    await assertFails(batch.commit());
    await assertFails(deleteDoc(doc(db, 'households/h1/items/legacy')));
    // Ticking stays possible, but not ticking and renaming at once.
    await assertSucceeds(updateDoc(doc(db, 'households/h1/items/legacy'), { completed: true, completedAt: 5, updatedAt: 5 }));
    await assertFails(updateDoc(doc(db, 'households/h1/items/alices'), { completed: true, name: 'Beer' }));
  });

  it('a helper can’t read spending, by document, list or query', async () => {
    await seed('households/h1/spendingTransactions/t1', { date: '2031-01-01', description: 'X', amount: 1, by: ALICE });
    for (const who of [HELEN, KIM]) {
      await assertFails(getDoc(doc(as(who), 'households/h1/spendingTransactions/t1')));
      await assertFails(getDocs(collection(as(who), 'households/h1/spendingTransactions')));
      await assertFails(getDocs(query(collection(as(who), 'households/h1/spendingTransactions'), where('by', '==', who))));
      await assertFails(getDoc(doc(as(who), 'households/h1/spendingSettings/main')));
    }
  });

  it('a helper can’t give a restricted course’s dose, even in another helper’s name', async () => {
    await seed('households/h1/petMedCourses/k1', {
      petId: 'p1', name: 'Pill', dose: '', timesPerDay: 1, times: ['09:00'], startDate: '2031-05-12', days: 7, withFood: false, givers: 'approved', approvedHelpers: [HELEN], createdAt: 1, by: ALICE,
    });
    const dose = (by: string) => ({ petId: 'p1', courseId: 'k1', slot: 0, at: 1, by, createdAt: 1 });
    await assertFails(setDoc(doc(as(HANK), 'households/h1/petMedDoses/x'), dose(HANK)));
    await assertFails(setDoc(doc(as(HANK), 'households/h1/petMedDoses/x'), dose(HELEN)));
    await assertFails(setDoc(doc(as(HANK), 'households/h1/petMedDoses/x'), dose(ALICE)));
  });

  it('a kid can’t give medicine by adding a dose to an existing record of their own', async () => {
    await seed('households/h1/petMedDoses/kims', { petId: 'p1', courseId: 'k9', slot: 0, at: 1, by: KIM, createdAt: 1 });
    await assertFails(updateDoc(doc(as(KIM), 'households/h1/petMedDoses/kims'), { at: 2 }));
  });

  it('someone with an unverified address for a helper gets nothing', async () => {
    const unverified = env.authenticatedContext('helen', { email: HELEN, email_verified: false }).firestore();
    await assertFails(getDoc(doc(unverified, 'households/h1')));
    await assertFails(getDocs(query(collection(unverified, 'households/h1/items'))));
  });
});

describe('to-do list', () => {
  const todo = (by: string, extra: Record<string, unknown> = {}) => ({
    app: 'tasks', ref: 'item:i1', title: 'Fix the porch light', createdAt: 1700000000000, url: 'https://huishouden-piekstra.web.app/tasks/?item=i1',
    status: 'open', private: false, owner: ALICE, updatedAt: 1, by,
    done: { label: 'Done', roles: ['admin', 'member', 'helper', 'kid'], ops: [{ col: 'items', id: 'i1', data: { completed: true, completedAt: '$now' }, merge: true }] },
    cancel: { label: 'Cancel', roles: ['admin', 'member'], owner: true, ops: [{ col: 'items', id: 'i1', data: { completed: true, cancelledAt: '$now', cancelledBy: '$me' }, merge: true }] },
    ...extra,
  });
  const path = (id = 'tasks:item:i1') => `households/h1/todos/${id}`;
  beforeEach(async () => {
    await seed(path(), todo(ALICE));
    await seed(path('baby:appt:a1'), todo(ALICE, { app: 'baby', ref: 'appt:a1', private: true }));
    await seed(path('bills:bill:b1'), todo(ALICE, { app: 'bills', ref: 'bill:b1', private: true }));
  });

  it('lets admins and members read every item; helpers and kids only open ones, asking for them; outsiders nothing', async () => {
    for (const who of [ALICE, BOB]) await assertSucceeds(getDocs(collection(as(who), 'households/h1/todos')));
    for (const who of [HELEN, KIM]) {
      await assertSucceeds(getDoc(doc(as(who), path())));
      await assertFails(getDoc(doc(as(who), path('baby:appt:a1'))));
      await assertFails(getDoc(doc(as(who), path('bills:bill:b1'))));
      await assertSucceeds(getDocs(query(collection(as(who), 'households/h1/todos'), where('private', '==', false))));
      await assertFails(getDocs(collection(as(who), 'households/h1/todos')));
    }
    await assertFails(getDoc(doc(as(MALLORY), path())));
    await assertFails(getDocs(query(collection(as(MALLORY), 'households/h1/todos'), where('private', '==', false))));
  });

  it('carries the title, detail and button words in other languages, strings within the fields’ limits added up', async () => {
    const texts = { es: { title: 'Arreglar la luz del porche', done: 'Listo', cancel: 'Cancelar' }, nl: { title: 'Lamp bij de veranda maken', detail: 'Buiten', done: 'Klaar' } };
    await assertSucceeds(setDoc(doc(as(BOB), path('tasks:item:i5')), todo(BOB, { ref: 'item:i5', texts })));
    for (const bad of [{ fr: { title: 'x' } }, { es: { title: 'x'.repeat(200), detail: 'x'.repeat(169) } }, { es: { title: 7 } }, { es: { ops: [] } }, { es: 'x' }]) {
      await assertFails(setDoc(doc(as(BOB), path('tasks:item:i6')), todo(BOB, { ref: 'item:i6', texts: bad })));
    }
  });

  it('lets members publish and remove items, signed by them; outsiders can’t', async () => {
    await assertSucceeds(setDoc(doc(as(BOB), path('tasks:item:i2')), todo(BOB, { ref: 'item:i2' })));
    await assertSucceeds(deleteDoc(doc(as(BOB), path('tasks:item:i2'))));
    await assertFails(setDoc(doc(as(BOB), path('tasks:item:i3')), todo(ALICE, { ref: 'item:i3' })));
    await assertFails(setDoc(doc(as(MALLORY), path('tasks:item:i4')), todo(MALLORY, { ref: 'item:i4' })));
    await assertFails(deleteDoc(doc(as(MALLORY), path())));
  });

  it('lets helpers and kids keep open items in step (and restore one on Undo), never private or money ones', async () => {
    await assertSucceeds(setDoc(doc(as(HELEN), path()), todo(HELEN, { title: 'Fix the porch lights' })));
    await assertSucceeds(deleteDoc(doc(as(KIM), path())));
    await assertSucceeds(setDoc(doc(as(KIM), path()), todo(KIM)));
    await assertFails(setDoc(doc(as(HELEN), path('baby:appt:a1')), todo(HELEN, { app: 'baby', ref: 'appt:a1' })));
    await assertFails(deleteDoc(doc(as(HELEN), path('baby:appt:a1'))));
    await assertFails(deleteDoc(doc(as(HELEN), path('bills:bill:b1'))));
    await assertFails(setDoc(doc(as(HELEN), path('baby:appt:a2')), todo(HELEN, { app: 'baby', ref: 'appt:a2', private: true })));
    await assertFails(setDoc(doc(as(HELEN), path('bills:bill:b2')), todo(HELEN, { app: 'bills', ref: 'bill:b2', private: true })));
    await assertFails(setDoc(doc(as(HELEN), path('tasks:item:i5')), todo(HELEN, { url: 'https://evil.example.com/' })));
  });

  it('keeps Bills’ items private whoever writes them', async () => {
    await assertFails(setDoc(doc(as(BOB), path('bills:bill:b3')), todo(BOB, { app: 'bills', ref: 'bill:b3', private: false })));
    await assertSucceeds(setDoc(doc(as(BOB), path('bills:bill:b3')), todo(BOB, { app: 'bills', ref: 'bill:b3', private: true })));
  });

  it('checks the shape: id under its app, exact fields, actions with a label, 1–8 ops and known roles', async () => {
    const bob = (id: string, extra: Record<string, unknown>) => setDoc(doc(as(BOB), path(id)), todo(BOB, extra));
    await assertFails(bob('home:item:i1', {}));
    await assertFails(bob('tasks:item:i1', { extra: 1 }));
    await assertFails(bob('tasks:item:i1', { status: 'done' }));
    await assertFails(bob('tasks:item:i1', { createdAt: 'yesterday' }));
    await assertFails(bob('tasks:item:i1', { url: 'javascript:alert(1)' }));
    await assertFails(bob('tasks:item:i1', { title: '' }));
    await assertFails(bob('tasks:item:i1', { done: { label: '', roles: [], ops: [{ col: 'items', id: 'i1', data: null }] } }));
    await assertFails(bob('tasks:item:i1', { done: { label: 'Done', roles: ['admin'], ops: [] } }));
    await assertFails(bob('tasks:item:i1', { done: { label: 'Done', roles: ['owner'], ops: [{ col: 'items', id: 'i1', data: null }] } }));
    await assertFails(bob('tasks:item:i1', { done: { label: 'Done', roles: ['admin'], ops: Array.from({ length: 9 }, () => ({ col: 'items', id: 'i1', data: null })) } }));
    await assertFails(bob('tasks:item:i1', { done: { label: 'Done', roles: ['admin'], emails: ['Not an email'], ops: [{ col: 'items', id: 'i1', data: null }] } }));
    await assertFails(bob('groceries:list', { app: 'groceries', ref: 'list', status: 'info', done: null }));
    const { done: _d, cancel: _c, owner: _o, ...summary } = todo(BOB, { app: 'groceries', ref: 'list', status: 'info', due: 5, who: 'Everyone', detail: '6 on the list' });
    await assertSucceeds(setDoc(doc(as(BOB), path('groceries:list')), summary));
  });
});

describe('cancelling from the To-do list', () => {
  const cases: { col: string; doc: (by: string) => Record<string, unknown>; cancel: Record<string, unknown>; bad: Record<string, unknown> }[] = [
    { col: 'items', doc: (by) => ({ name: 'Fix the porch light', listId: 'chores', completed: false, by }), cancel: { completed: true, completedAt: 5, cancelledAt: 5, cancelledBy: BOB }, bad: { cancelledAt: 'now' } },
    { col: 'babyChecklists', doc: (by) => ({ list: 'Paperwork', text: 'Book the pediatrician', done: false, order: 1, createdAt: 1, by }), cancel: { skipped: true, skippedAt: 5 }, bad: { skipped: 'yes' } },
    { col: 'homeTasks', doc: (by) => ({ title: 'Change filter', category: 'hvac', schedule: { kind: 'after-done', every: 3, unit: 'month' }, due: '2031-05-01', createdAt: 1, by }), cancel: { pausedAt: 5, updatedAt: 5 }, bad: { pausedAt: true } },
    { col: 'carServiceItems', doc: (by) => ({ vehicleId: 'v1', name: 'Oil change', everyMonths: 6, createdAt: 1, by }), cancel: { pausedAt: 5, updatedAt: 5 }, bad: { pausedAt: -1 } },
    { col: 'carRenewals', doc: (by) => ({ vehicleId: 'v1', kind: 'registration', name: 'Registration', dueDate: '2031-05-01', everyMonths: 12, createdAt: 1, by }), cancel: { closedAt: 5, updatedAt: 5 }, bad: { closedAt: 'soon' } },
    { col: 'petReminders', doc: (by) => ({ petId: 'p1', kind: 'vaccine', title: 'Rabies booster', due: '2031-05-12', createdAt: 1, by }), cancel: { dismissedAt: 5, updatedAt: 5 }, bad: { dismissedAt: 'today' } },
  ];
  for (const c of cases) {
    describe(c.col, () => {
      const theirs = `households/h1/${c.col}/theirs`;
      beforeEach(() => seed(theirs, c.doc(ALICE)));
      it('admins and members cancel anyone’s; helpers and kids only their own', async () => {
        await assertSucceeds(setDoc(doc(as(BOB), theirs), c.cancel, { merge: true }));
        await seed(theirs, c.doc(ALICE));
        await assertFails(setDoc(doc(as(HELEN), theirs), c.cancel, { merge: true }));
        await assertFails(setDoc(doc(as(KIM), theirs), c.cancel, { merge: true }));
        const mine = `households/h1/${c.col}/mine`;
        await seed(mine, c.doc(HELEN));
        await assertSucceeds(setDoc(doc(as(HELEN), mine), c.cancel, { merge: true }));
      });
      it('refuses a cancel field of the wrong type', async () => {
        await assertFails(setDoc(doc(as(ALICE), theirs), c.bad, { merge: true }));
      });
    });
  }

  it('Home: anyone skips the thing to do before an event, in their own name', async () => {
    await seed('households/h1/homeEvents/e1', { title: 'Garbage pickup', kind: 'trash', rule: { freq: 'week', every: 1, start: '2031-01-02' }, createdAt: 1, by: ALICE });
    await assertSucceeds(setDoc(doc(as(KIM), 'households/h1/homeEventPrep/e1_2031-01-09'), { done: true, skipped: true, at: 5, by: KIM }));
    await assertFails(setDoc(doc(as(KIM), 'households/h1/homeEventPrep/e1_2031-01-16'), { done: true, skipped: 'yes', at: 5, by: KIM }));
  });

  it('Pet: a helper skips a dose they may give; a kid never', async () => {
    await seed('households/h1/petMedCourses/c1', { petId: 'p1', name: 'Carprofen', dose: '1 tablet', timesPerDay: 1, times: ['08:00'], startDate: '2031-05-01', days: 5, withFood: true, createdAt: 1, by: ALICE });
    const dose = (by: string) => ({ petId: 'p1', courseId: 'c1', slot: 0, at: 5, skipped: true, by, createdAt: 5 });
    await assertSucceeds(setDoc(doc(as(HELEN), 'households/h1/petMedDoses/c1_2031-05-02_0'), dose(HELEN)));
    await assertFails(setDoc(doc(as(KIM), 'households/h1/petMedDoses/c1_2031-05-03_0'), dose(KIM)));
    await assertFails(setDoc(doc(as(BOB), 'households/h1/petMedDoses/c1_2031-05-04_0'), { ...dose(BOB), skipped: 1 }));
  });
});
