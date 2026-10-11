import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteField, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

// Each member's language (@huishouden/pwa-kit/member-lang): `langs` on the household, by email,
// written by that member only, read by every member with the household.
const ADMIN = 'ana@example.com';
const MEMBER = 'ben@example.com';
const HELPER = 'cleo@example.com';
const KID = 'dan@example.com';
const STRANGER = 'eve@example.com';
const H = 'households/h1';

let env: RulesTestEnvironment;
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-huishouden-rules', firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') } });
});
afterAll(async () => {
  await env.cleanup();
});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), H), {
      name: 'Home',
      members: [ADMIN, MEMBER, HELPER, KID],
      roles: { [ADMIN]: 'admin', [MEMBER]: 'member', [HELPER]: 'helper', [KID]: 'kid' },
      joined: [ADMIN, MEMBER, HELPER, KID],
      langs: { [ADMIN]: 'en' },
      createdAt: 1,
    });
  });
});

const as = (email: string) => env.authenticatedContext(email.split('@')[0], { email, email_verified: true }).firestore();
const mine = (email: string, lang: unknown) => setDoc(doc(as(email), H), { langs: { [email]: lang } }, { merge: true });

describe("a member's language", () => {
  it('every role stores and changes their own, as the kit writes it (a merge of one entry)', async () => {
    for (const email of [ADMIN, MEMBER, HELPER, KID]) {
      await assertSucceeds(mine(email, 'nl'));
      await assertSucceeds(mine(email, 'es'));
    }
    await assertSucceeds(getDoc(doc(as(KID), H)));
  });

  it('refuses a member invited but not yet joined', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), H), { joined: [ADMIN, MEMBER, KID] });
    });
    await assertFails(mine(HELPER, 'nl'));
    await assertSucceeds(mine(MEMBER, 'nl'));
  });

  it('refuses a language the suite does not speak, or not a string', async () => {
    await assertFails(mine(MEMBER, 'fr'));
    await assertFails(mine(MEMBER, 3));
    await assertFails(mine(MEMBER, { lang: 'en' }));
  });

  it("refuses writing anyone else's, even an admin's", async () => {
    await assertFails(setDoc(doc(as(ADMIN), H), { langs: { [MEMBER]: 'nl' } }, { merge: true }));
    await assertFails(setDoc(doc(as(HELPER), H), { langs: { [HELPER]: 'nl', [KID]: 'nl' } }, { merge: true }));
    await assertFails(setDoc(doc(as(MEMBER), H), { langs: { [ADMIN]: 'es' } }, { merge: true }));
  });

  it('refuses a stranger and a write that changes anything else with it', async () => {
    await assertFails(mine(STRANGER, 'en'));
    await assertFails(setDoc(doc(as(HELPER), H), { name: 'Mine', langs: { [HELPER]: 'nl' } }, { merge: true }));
    await assertFails(updateDoc(doc(as(MEMBER), H), { langs: 'nl' }));
  });

  it('refuses removing your own entry or the whole map', async () => {
    await assertFails(updateDoc(doc(as(ADMIN), H), { [`langs`]: deleteField() }));
    await assertFails(updateDoc(doc(as(MEMBER), H), { langs: {} }));
  });

  it("an admin removing someone drops their entry with them, and changes no one else's", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), H), { langs: { [ADMIN]: 'en', [HELPER]: 'es', [MEMBER]: 'nl' } });
    });
    const rest = { members: [ADMIN, MEMBER, KID], roles: { [ADMIN]: 'admin', [MEMBER]: 'member', [KID]: 'kid' } };
    await assertFails(updateDoc(doc(as(ADMIN), H), { ...rest, langs: { [ADMIN]: 'en', [MEMBER]: 'es' } }));
    await assertFails(updateDoc(doc(as(ADMIN), H), { ...rest, langs: { [ADMIN]: 'en', [MEMBER]: 'nl', [KID]: 'nl' } }));
    // Dropping someone who stays: alone, with a rename, or alongside the removal.
    await assertFails(updateDoc(doc(as(ADMIN), H), { langs: { [ADMIN]: 'en', [HELPER]: 'es' } }));
    await assertFails(updateDoc(doc(as(ADMIN), H), { name: 'Renamed', langs: { [ADMIN]: 'en', [HELPER]: 'es' } }));
    await assertFails(updateDoc(doc(as(ADMIN), H), { ...rest, langs: { [ADMIN]: 'en' } }));
    await assertSucceeds(updateDoc(doc(as(ADMIN), H), { ...rest, langs: { [ADMIN]: 'en', [MEMBER]: 'nl' } }));
  });

  it('a member renaming the household leaves languages alone, and may not touch them', async () => {
    await assertSucceeds(updateDoc(doc(as(MEMBER), H), { name: 'Our place' }));
    await assertFails(updateDoc(doc(as(MEMBER), H), { name: 'Elsewhere', langs: { [ADMIN]: 'en', [MEMBER]: 'nl' } }));
  });
});
