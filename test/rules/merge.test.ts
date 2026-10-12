import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';

// Things that may show as one (@huishouden/pwa-kit/merge): `merge` on agenda items and reminders,
// and its words in each reader's language in `texts`.
const ADMIN = 'test-a@example.com';
const HELPER = 'test-h@example.com';
const MEMBERS = [ADMIN, HELPER];
const URL = 'https://huishouden-staging.web.app/home/#regular';
const MERGE = { key: 'collection', part: 'garbage', title: '{parts} pickup' };
const TEXTS = {
  es: { title: 'Recogida de basura', detail: 'Todos los lunes y jueves', mergePart: 'basura', mergeTitle: 'Recogida de {parts}' },
  nl: { title: 'Afval ophalen', detail: 'Elke maandag en donderdag', mergePart: 'afval', mergeTitle: '{parts} ophalen' },
};

const item = (by: string, extra: Record<string, unknown> = {}) => ({
  app: 'home', ref: 'event:garbage', kind: 'other', title: 'Garbage pickup', start: 1949000000000, allDay: true, detail: 'Every Monday and Thursday', url: URL, private: false,
  series: { rule: { freq: 'week', every: 1, start: '2031-09-01', days: [1, 4] }, original: '2031-10-06', through: '2031-11-30' },
  merge: MERGE, texts: TEXTS, updatedAt: 1, by, ...extra,
});

const REMINDER_TEXTS = {
  es: { title: 'Saca la basura', body: 'Recogida de basura mañana', mergePart: 'basura', mergeTitle: 'Saca la {parts}' },
  nl: { title: 'Afval buiten zetten', body: 'Morgen afval ophalen', mergePart: 'afval', mergeTitle: 'Zet het {parts} buiten' },
};

const reminder = (by: string, extra: Record<string, unknown> = {}) => ({
  app: 'home', title: 'Take the garbage out', body: 'Garbage pickup tomorrow', texts: REMINDER_TEXTS, at: 1949100000000, url: URL, recipients: 'all', ref: 'home:prep:garbage', private: false,
  source: { checks: [{ doc: 'homeEventPrep/garbage_2031-10-06', absent: true }, { doc: 'homeEvents/garbage' }] },
  merge: { key: 'prep', part: 'garbage', title: 'Take the {parts} out' }, sent: false, createdAt: 1, by, ...extra,
});

let env: RulesTestEnvironment;
const as = (email: string) => env.authenticatedContext(email, { email, email_verified: true }).firestore();

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-huishouden-rules', firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'households/h1'), { name: 'Home', members: MEMBERS, joined: MEMBERS, roles: { [HELPER]: 'helper' }, createdAt: 1 });
  });
});
afterAll(async () => {
  await env.cleanup();
});

describe('agenda items', () => {
  it('an admin and a helper publish an item with a merge and its words in every language', async () => {
    await assertSucceeds(setDoc(doc(as(ADMIN), 'households/h1/agenda/a1'), item(ADMIN)));
    await assertSucceeds(setDoc(doc(as(HELPER), 'households/h1/agenda/a2'), item(HELPER)));
  });

  it('a personal item may carry one too', async () => {
    await assertSucceeds(setDoc(doc(as(ADMIN), 'households/h1/personalAgenda/p1'), item(ADMIN, { app: 'pet', audience: [ADMIN], private: true })));
  });

  it('refuses a merge without {parts}, with other fields, too long, or not a map', async () => {
    for (const merge of [
      { ...MERGE, title: 'Pickup' },
      { ...MERGE, url: URL },
      { ...MERGE, key: 'k'.repeat(81) },
      { ...MERGE, part: '' },
      { ...MERGE, title: `{parts} ${'x'.repeat(120)}` },
      { key: 'collection', title: '{parts} pickup' },
      'collection',
    ]) {
      await assertFails(setDoc(doc(as(ADMIN), 'households/h1/agenda/bad'), item(ADMIN, { merge })));
    }
  });

  it('refuses unknown words in texts', async () => {
    await assertFails(setDoc(doc(as(ADMIN), 'households/h1/agenda/bad'), item(ADMIN, { texts: { nl: { ...TEXTS.nl, mergeUrl: URL } } })));
  });
});

describe('reminders', () => {
  it('a reminder with a source, a merge and words in every language', async () => {
    await assertSucceeds(setDoc(doc(as(ADMIN), 'households/h1/reminders/r1'), reminder(ADMIN)));
    await assertSucceeds(setDoc(doc(as(HELPER), 'households/h1/reminders/r2'), reminder(HELPER)));
  });

  it('a personal reminder with a merge', async () => {
    const { source: _s, ...rest } = reminder(ADMIN, { app: 'pet', recipients: [ADMIN], private: true, audience: [ADMIN] });
    await assertSucceeds(setDoc(doc(as(ADMIN), 'households/h1/personalReminders/p1'), rest));
  });

  it('refuses a broken merge', async () => {
    await assertFails(setDoc(doc(as(ADMIN), 'households/h1/reminders/bad'), reminder(ADMIN, { merge: { key: 'prep', part: 'garbage', title: 'Take it out' } })));
    await assertFails(setDoc(doc(as(ADMIN), 'households/h1/reminders/bad'), reminder(ADMIN, { merge: { key: 'prep', part: 'garbage', title: '{parts}', extra: 1 } })));
  });
});
