import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';

// Spending's alert inboxes (huishouden/calendar's mail checker writes them as the member who
// connected the inbox). One household with every role. All invented.
const ALICE = 'alice@example.com'; // admin (members[0])
const BOB = 'bob@example.com'; // member
const HELEN = 'helen@example.com'; // helper
const KIM = 'kim@example.com'; // kid
const MALLORY = 'mallory@example.com'; // not in the household
const MEMBERS = [ALICE, BOB, HELEN, KIM];
const ROLES = { [HELEN]: 'helper', [KIM]: 'kid' };
const H = 'households/h1';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-huishouden-inboxes',
    firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') },
  });
});
afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), H), { name: 'Home', members: MEMBERS, joined: MEMBERS, roles: ROLES, createdAt: 1 });
  });
});

const as = (email: string) => env.authenticatedContext(email.split('@')[0], { email, email_verified: true }).firestore();

const inbox = (by: string, extra: Record<string, unknown> = {}) => ({ address: 'alerts.example@example.com', connectedAt: 1, updatedAt: 1, by, ...extra });
const path = `${H}/spendingInboxes/ib-abc123`;

describe('spendingInboxes', () => {
  it('admins and members connect an inbox in their own name and both see it', async () => {
    await assertSucceeds(setDoc(doc(as(BOB), path), inbox(BOB)));
    await assertSucceeds(getDoc(doc(as(ALICE), path)));
    await assertSucceeds(getDocs(collection(as(ALICE), `${H}/spendingInboxes`)));
    await assertFails(setDoc(doc(as(BOB), `${H}/spendingInboxes/ib-2`), inbox(ALICE)));
  });

  it('helpers, kids and outsiders neither see nor write them', async () => {
    await assertSucceeds(setDoc(doc(as(BOB), path), inbox(BOB)));
    for (const who of [HELEN, KIM, MALLORY]) {
      await assertFails(getDoc(doc(as(who), path)));
      await assertFails(getDocs(collection(as(who), `${H}/spendingInboxes`)));
      await assertFails(setDoc(doc(as(who), `${H}/spendingInboxes/ib-${who.split('@')[0]}`), inbox(who)));
      await assertFails(deleteDoc(doc(as(who), path)));
    }
  });

  it("records the checker's state: last alert, how many were added, an error", async () => {
    await assertSucceeds(setDoc(doc(as(BOB), path), inbox(BOB)));
    await assertSucceeds(updateDoc(doc(as(BOB), path), { lastAlertAt: 5, lastAdded: 3, updatedAt: 5 }));
    await assertSucceeds(updateDoc(doc(as(BOB), path), { error: 'revoked', updatedAt: 6 }));
    await assertFails(updateDoc(doc(as(BOB), path), { lastAdded: -1, updatedAt: 7 }));
    await assertFails(updateDoc(doc(as(BOB), path), { error: 'x'.repeat(41), updatedAt: 7 }));
    await assertFails(updateDoc(doc(as(BOB), path), { lastAlertAt: 'today', updatedAt: 7 }));
  });

  it('never holds tokens, email content or unknown fields', async () => {
    await assertFails(setDoc(doc(as(BOB), path), inbox(BOB, { refreshToken: '1//abc' })));
    await assertFails(setDoc(doc(as(BOB), path), inbox(BOB, { subject: 'Your card was used' })));
    await assertFails(setDoc(doc(as(BOB), path), inbox(BOB, { address: 'not an address' })));
    await assertFails(setDoc(doc(as(BOB), path), inbox(BOB, { connectedAt: '1' })));
    await assertFails(setDoc(doc(as(BOB), `${H}/spendingInboxes/bad id`), inbox(BOB)));
  });

  it('another member connecting the same address takes it over', async () => {
    await assertSucceeds(setDoc(doc(as(BOB), path), inbox(BOB)));
    await assertSucceeds(setDoc(doc(as(ALICE), path), inbox(ALICE, { connectedAt: 2, updatedAt: 2 })));
  });

  it('the member who connected it, or an admin, removes it; another member does not', async () => {
    await assertSucceeds(setDoc(doc(as(ALICE), path), inbox(ALICE)));
    await assertFails(deleteDoc(doc(as(BOB), path)));
    await assertSucceeds(deleteDoc(doc(as(ALICE), path)));
    await assertSucceeds(setDoc(doc(as(BOB), path), inbox(BOB)));
    await assertSucceeds(deleteDoc(doc(as(ALICE), path)));
  });
});
