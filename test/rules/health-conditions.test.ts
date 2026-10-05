import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';

// Health conditions: fewer readers than medicines. Nan is looked after by Bob (a member) and Helen
// (a helper); Alice is the admin. Hank is a helper who is himself a person in Health (his own
// email on his record). Carol is a member who doesn't care for Nan, Kim a kid listed as a carer by
// mistake, Mallory in no household. All invented.
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
const HP = 'households/h1/healthPeople/hank';
const C = `${P}/conditions`;

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-huishouden-health-conditions',
    firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') },
  });
});
afterAll(async () => {
  await env.cleanup();
});

const condition = (by: string, over: Record<string, unknown> = {}, personId = 'nan') => ({
  personId, name: 'Cervical radiculopathy', icd10: 'M54.12', specialty: 'neurology', status: 'active', diagnosed: '2030-03', severity: 'moderate',
  doctorId: 'c1', clinicId: 'c2', medIds: ['m1'], notes: 'Left arm, worse at night.', createdAt: 1, by, ...over,
});
const visit = (by: string, over: Record<string, unknown> = {}) => ({
  personId: 'nan', kind: 'specialist', at: 1_936_000_000_000, remindBefore: [1440, 120], createdAt: 1, by, ...over,
});

async function seed(path: string, data: Record<string, unknown>) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
}

beforeEach(async () => {
  await env.clearFirestore();
  await seed('households/h1', { name: 'Home', members: MEMBERS, joined: MEMBERS, roles: ROLES, createdAt: 1 });
  await seed(P, { name: 'Nan', carers: [BOB, HELEN, KIM], readers: [BOB, HELEN, KIM], createdAt: 1, by: ALICE });
  await seed(HP, { name: 'Hank', email: HANK, carers: [], readers: [HANK], createdAt: 1, by: ALICE });
  await seed(`${C}/k1`, condition(BOB));
  await seed(`${HP}/conditions/k1`, condition(ALICE, {}, 'hank'));
});

const as = (email: string) => env.authenticatedContext(email.split('@')[0], { email, email_verified: true }).firestore();
const ok = (allowed: boolean, p: Promise<unknown>) => (allowed ? assertSucceeds(p) : assertFails(p));

describe('health conditions: reading', () => {
  it("only admins and member carers read a person's conditions; helper carers, other members, kids and outsiders never", async () => {
    for (const [who, allowed] of [[ALICE, true], [BOB, true], [HELEN, false], [CAROL, false], [HANK, false], [KIM, false], [MALLORY, false]] as const) {
      await ok(allowed, getDoc(doc(as(who), `${C}/k1`)));
      await ok(allowed, getDocs(collection(as(who), C)));
    }
  });

  it('the person reads their own, whatever their role (a helper here); nobody without a reason does', async () => {
    await assertSucceeds(getDoc(doc(as(HANK), `${HP}/conditions/k1`)));
    await assertSucceeds(getDocs(collection(as(HANK), `${HP}/conditions`)));
    await assertSucceeds(getDoc(doc(as(ALICE), `${HP}/conditions/k1`)));
    for (const who of [BOB, HELEN, CAROL, KIM, MALLORY]) await assertFails(getDoc(doc(as(who), `${HP}/conditions/k1`)));
  });
});

describe('health conditions: keeping', () => {
  it('admins and member carers add, change and remove; the person as a helper, helper carers and others never', async () => {
    await assertSucceeds(setDoc(doc(as(ALICE), `${C}/a`), condition(ALICE)));
    await assertSucceeds(setDoc(doc(as(BOB), `${C}/b`), condition(BOB, { via: 'assistant' })));
    await assertSucceeds(updateDoc(doc(as(BOB), `${C}/k1`), { status: 'resolved', resolved: '2031', updatedAt: 5, by: BOB }));
    for (const who of [HELEN, CAROL, HANK, KIM, MALLORY]) {
      await assertFails(setDoc(doc(as(who), `${C}/x`), condition(who)));
      await assertFails(updateDoc(doc(as(who), `${C}/k1`), { name: 'Changed', updatedAt: 5, by: who }));
      await assertFails(deleteDoc(doc(as(who), `${C}/k1`)));
    }
    // Hank reads his own but, as a helper, doesn't keep it.
    await assertFails(setDoc(doc(as(HANK), `${HP}/conditions/x`), condition(HANK, {}, 'hank')));
    await assertSucceeds(deleteDoc(doc(as(BOB), `${C}/k1`)));
  });

  it('only the fields Health writes, in their shapes', async () => {
    const { icd10: _i, diagnosed: _d, severity: _s, doctorId: _doc, clinicId: _c, medIds: _m, notes: _n, ...bare } = condition(BOB, { specialty: 'primary', place: 'Example Clinic' });
    await assertSucceeds(setDoc(doc(as(BOB), `${C}/bare`), bare));
    for (const diagnosed of ['2019', '2019-03', '2019-03-14']) await assertSucceeds(setDoc(doc(as(BOB), `${C}/d${diagnosed}`), condition(BOB, { diagnosed })));
    for (const over of [
      { name: '' },
      { name: 'x'.repeat(121) },
      { icd10: 'radiculopathy' },
      { icd10: 'M54.12345' },
      { specialty: 'surgery' },
      { status: 'cured' },
      { diagnosed: '19' },
      { diagnosed: '2019-13' },
      { diagnosed: 2019 },
      { resolved: '2031' },
      { severity: 'fatal' },
      { doctorId: ['c1'] },
      { place: 'x'.repeat(201) },
      { medIds: 'm1' },
      { medIds: Array.from({ length: 21 }, (_, i) => `m${i}`) },
      { notes: 'x'.repeat(1001) },
      { personId: 'someone' },
      { via: 'email' },
      { by: ALICE },
      { createdAt: 'now' },
      { audience: [BOB] },
    ]) {
      await assertFails(setDoc(doc(as(BOB), `${C}/x`), condition(BOB, over)));
    }
  });
});

describe('health conditions: visits about one', () => {
  it('a visit carries the condition it is about and its medical area; a helper carer may add one with an area', async () => {
    await assertSucceeds(setDoc(doc(as(BOB), `${P}/visits/v1`), visit(BOB, { conditionId: 'k1', specialty: 'neurology' })));
    await assertSucceeds(setDoc(doc(as(HELEN), `${P}/visits/v2`), visit(HELEN, { specialty: 'cardiology' })));
    // Helen reads the visit, and with it only the condition's id: the condition itself stays closed.
    await assertSucceeds(getDoc(doc(as(HELEN), `${P}/visits/v1`)));
    await assertFails(getDoc(doc(as(HELEN), `${C}/k1`)));
    await assertFails(setDoc(doc(as(BOB), `${P}/visits/v3`), visit(BOB, { specialty: 'surgery' })));
    await assertFails(setDoc(doc(as(BOB), `${P}/visits/v4`), visit(BOB, { conditionId: 'x'.repeat(129) })));
    await assertFails(setDoc(doc(as(BOB), `${P}/visits/v5`), visit(BOB, { conditionId: 5 })));
  });
});
