import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';

// A to-do as Health writes it (pwa-kit personalTodoDoc after localizeTodos): Given and Skipped, each
// writing a dose with its fields, named givers, an audience, and every language's words.
const TODO = {"app": "health", "ref": "missed:demo-person-ria:2031-05-14T08:00", "title": "Not marked: 8 AM medicine for Oma Ria", "detail": "1 medicine not marked as given", "createdAt": 1936512000000, "due": 1936512000000, "who": "Oma Ria", "url": "https://huishouden-staging.web.app/health/?tab=today&person=demo-person-ria", "status": "open", "private": true, "done": {"label": "Given", "ops": [{"col": "healthPeople/demo-person-ria/doses", "id": "demo-med-metformin_2031-05-14T0800", "data": {"personId": "demo-person-ria", "medId": "demo-med-metformin", "slot": "2031-05-14T08:00", "at": 1936512000000, "status": "given", "by": "$me", "createdAt": "$now"}}], "roles": ["admin"], "emails": ["test-b@example.com"]}, "cancel": {"label": "Skipped", "ops": [{"col": "healthPeople/demo-person-ria/doses", "id": "demo-med-metformin_2031-05-14T0800", "data": {"personId": "demo-person-ria", "medId": "demo-med-metformin", "slot": "2031-05-14T08:00", "at": 1936512000000, "status": "skipped", "by": "$me", "createdAt": "$now"}}], "roles": ["admin"], "emails": ["test-b@example.com"]}, "texts": {"en": {"title": "Not marked: 8 AM medicine for Oma Ria", "detail": "1 medicine not marked as given", "done": "Given", "cancel": "Skipped"}, "es": {"title": "Sin marcar: medicamento de las 8 a.m. para Oma Ria", "detail": "1 medicamento sin marcar como dado", "done": "Dada", "cancel": "Omitida"}, "nl": {"title": "Niet afgevinkt: medicijn van 8:00 voor Oma Ria", "detail": "1 medicijn niet als gegeven afgevinkt", "done": "Gegeven", "cancel": "Overgeslagen"}}, "updatedAt": 1936521000000, "by": "test-a@example.com", "audience": ["test-a@example.com", "test-b@example.com"]};

let env: RulesTestEnvironment;
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-huishouden-rules', firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'households/h1'), { name: 'Home', members: ['test-a@example.com', 'test-b@example.com'], createdAt: 1 });
  });
});
afterAll(async () => {
  await env.cleanup();
});

const write = (id: string, d: unknown) =>
  setDoc(doc(env.authenticatedContext('a', { email: 'test-a@example.com', email_verified: true }).firestore(), 'households/h1/personalTodos/health:' + id), d as Record<string, unknown>);
const copy = () => JSON.parse(JSON.stringify(TODO));

it("accepts Health's personal to-do with two dose actions and texts in all three languages", async () => {
  const db = env.authenticatedContext('a', { email: 'test-a@example.com', email_verified: true }).firestore();
  await assertSucceeds(setDoc(doc(db, 'households/h1/personalTodos/health:' + TODO.ref), TODO));
});

it('accepts the largest: twelve readers and givers, eight doses per action', async () => {
  const d = copy();
  const emails = ['test-a@example.com', ...Array.from({ length: 11 }, (_, i) => `carer-${i}@example.com`)];
  d.audience = emails;
  for (const a of [d.done, d.cancel]) {
    a.emails = emails;
    a.ops = Array.from({ length: 8 }, () => a.ops[0]);
  }
  await assertSucceeds(write('largest', d));
});

it('refuses texts that are not all strings, or too long', async () => {
  const d = copy();
  d.texts.es.detail = 5;
  await assertFails(write('number', d));
  const e = copy();
  e.texts.nl.title = 'x'.repeat(400);
  await assertFails(write('long', e));
});

it("refuses givers who don't read the to-do, and an action without its label", async () => {
  const d = copy();
  d.done.emails = ['someone-else@example.com'];
  await assertFails(write('outsider', d));
  const e = copy();
  delete e.done.label;
  await assertFails(write('nolabel', e));
});
