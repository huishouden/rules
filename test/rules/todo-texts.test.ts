import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, it } from 'vitest';
import { assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';

// A to-do as Bills writes it (pwa-kit todoDoc after localizeTodos): two actions and every language's
// words. Its checks come close to the rules' 1000-expression limit, which once refused it.
const TODO = {"app": "bills", "ref": "bill:b1", "title": "Todo bill x", "detail": "$42.00", "createdAt": 1791097771273, "due": 1791086400000, "url": "https://huishouden-staging.web.app/bills/", "status": "open", "private": true, "owner": "test-a@example.com", "done": {"label": "Mark paid", "ops": [{"col": "bills", "id": "b1", "data": {"status": "paid", "paidAt": "$now", "paidBy": "$me", "paidVia": "member", "updatedAt": "$now"}, "merge": true}], "roles": ["admin", "member"]}, "cancel": {"label": "Skip", "ops": [{"col": "bills", "id": "b1", "data": {"dismissed": true, "updatedAt": "$now"}, "merge": true}], "roles": ["admin", "member"]}, "texts": {"en": {"title": "Todo bill x", "detail": "$42.00", "done": "Mark paid", "cancel": "Skip"}, "es": {"title": "Todo bill x", "detail": "$42.00", "done": "Marcar pagada", "cancel": "Omitir"}, "nl": {"title": "Todo bill x", "detail": "$ 42,00", "done": "Betaald", "cancel": "Overslaan"}}, "updatedAt": 1791097771273, "by": "test-a@example.com"};

let env: RulesTestEnvironment;
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-huishouden-rules', firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'households/h1'), { name: 'Home', members: ['test-a@example.com'], createdAt: 1 });
  });
});
afterAll(async () => {
  await env.cleanup();
});

it('accepts a full to-do with actions and texts in all three languages', async () => {
  const db = env.authenticatedContext('a', { email: 'test-a@example.com', email_verified: true }).firestore();
  await assertSucceeds(setDoc(doc(db, 'households/h1/todos/bills:bill:b1'), TODO));
});
