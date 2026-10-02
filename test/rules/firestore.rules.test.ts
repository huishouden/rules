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
    projectId: 'demo-hearthlist',
    firestore: {
      rules: readFileSync(resolve(__dirname, '../../../firestore.rules'), 'utf8'),
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
    const layout = { name: 'Publix', categoryOrder: ['Frozen Foods'], aisleLabels: {}, location: null, createdAt: 1 };
    await assertSucceeds(setDoc(doc(as(ALICE), 'households/h1/stores/s1'), layout));
    await assertSucceeds(getDoc(doc(as(BOB), 'households/h1/stores/s1')));
    await assertFails(getDoc(doc(as(MALLORY), 'households/h1/stores/s1')));
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/stores/s2'), { ...layout, name: '' }));
  });

  it('lets members record learned aisles, within limits', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'households/h1/stores/s1'), { name: 'Publix', categoryOrder: [] });
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
      await setDoc(doc(ctx.firestore(), 'households/h1/spendingTransactions/t1'), { amount: 12.5, merchant: 'Publix' });
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

  it('rejects items without a name', async () => {
    await assertFails(setDoc(doc(as(ALICE), 'households/h1/items/i3'), { name: '', listId: 'groceries', completed: false }));
  });
});
