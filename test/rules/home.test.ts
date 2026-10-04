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

// The household's home (`households/{id}.home`, @huishouden/pwa-kit/home) and contacts' map
// positions. One household with every role: Alice created it (admin by being first), Bob is a member by
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

const home = (by: string, extra: Record<string, unknown> = {}) => ({
  address: '12 Example Lane, Springfield, Illinois 62701',
  lat: 39.7817,
  lng: -89.6501,
  placeId: 'way/424242',
  timeZone: 'America/Chicago',
  setBy: by,
  updatedAt: 1,
  ...extra,
});

describe('the home', () => {
  it('every member reads it with the household, helpers and kids too; outsiders don’t', async () => {
    await seed('households/h1', { name: 'Home', members: MEMBERS, joined: MEMBERS, roles: ROLES, createdAt: 1, home: home(ALICE) });
    for (const who of EVERYONE) await expect(IN_HOUSEHOLD.includes(who), getDoc(h1(as(PERSON[who]))));
  });

  it('admins and members set it in their own name; helpers, kids and outsiders can’t', async () => {
    for (const who of EVERYONE) await expect(STAFF.includes(who), updateDoc(h1(as(PERSON[who])), { home: home(PERSON[who]) }));
    await assertFails(updateDoc(h1(as(BOB)), { home: home(ALICE) }));
  });

  it('approximate, without a place or a zone, is fine', async () => {
    await assertSucceeds(updateDoc(h1(as(BOB)), { home: { address: 'Riverside, Springfield', lat: 39.78, lng: -89.64, approximate: true, setBy: BOB, updatedAt: 2 } }));
  });

  it('refuses a broken home', async () => {
    const bad: Record<string, unknown>[] = [
      { lat: 91 },
      { lng: -181 },
      { lat: '39.7' },
      { address: '' },
      { address: 'x'.repeat(301) },
      { placeId: 'p'.repeat(101) },
      { timeZone: 'Europe/Amsterdam; drop' },
      { approximate: 'yes' },
      { updatedAt: 'now' },
      { extra: 1 },
    ];
    for (const b of bad) await assertFails(updateDoc(h1(as(ALICE)), { home: home(ALICE, b) }));
    const { lng: _lng, ...noLng } = home(ALICE);
    await assertFails(updateDoc(h1(as(ALICE)), { home: noLng }));
    await assertFails(updateDoc(h1(as(ALICE)), { home: '12 Example Lane' }));
  });

  it('admins and members remove it; helpers and kids can’t', async () => {
    for (const who of ['helper', 'kid', 'member'] as Who[]) {
      await seed('households/h1', { name: 'Home', members: MEMBERS, joined: MEMBERS, roles: ROLES, createdAt: 1, home: home(ALICE) });
      await expect(STAFF.includes(who), updateDoc(h1(as(PERSON[who])), { home: deleteField() }));
    }
  });

  it('a rename keeps a home someone else set', async () => {
    await seed('households/h1', { name: 'Home', members: MEMBERS, joined: MEMBERS, roles: ROLES, createdAt: 1, home: home(ALICE) });
    await assertSucceeds(updateDoc(h1(as(BOB)), { name: 'Ours' }));
  });

  it('a new household starts without one', async () => {
    await assertFails(setDoc(doc(as(MALLORY), 'households/h2'), { name: 'New', members: [MALLORY], createdAt: Date.now(), home: home(MALLORY) }));
  });
});

describe('contacts on the map', () => {
  const vet = (by: string, extra: Record<string, unknown> = {}) => ({ name: 'Example Vet', address: '1 Main St', apps: ['pet'], private: false, createdAt: 1, by, ...extra });
  const at = (id: string, data: Record<string, unknown>, who = ALICE) => setDoc(doc(as(who), `households/h1/contacts/${id}`), data);

  it('a position with its address, written by anyone who may write the contact', async () => {
    await assertSucceeds(at('c1', vet(ALICE, { lat: 39.78, lng: -89.6 })));
    await assertSucceeds(at('c2', vet(HELEN, { lat: 39.78, lng: -89.6 }), HELEN));
  });

  it('both or neither, on the map, and only with an address', async () => {
    await assertFails(at('c3', vet(ALICE, { lat: 39.78 })));
    await assertFails(at('c4', vet(ALICE, { lng: -89.6 })));
    await assertFails(at('c5', vet(ALICE, { lat: 91, lng: 0 })));
    await assertFails(at('c6', vet(ALICE, { lat: 0, lng: 181 })));
    await assertFails(at('c7', vet(ALICE, { lat: '39', lng: '-89' })));
    const { address: _a, ...noAddress } = vet(ALICE, { lat: 39.78, lng: -89.6 });
    await assertFails(at('c8', noAddress));
  });
});
