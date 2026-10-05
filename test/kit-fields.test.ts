import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as agenda from '@huishouden/pwa-kit/agenda-core';
import * as calendarExport from '@huishouden/pwa-kit/calendar-export';
import * as contact from '@huishouden/pwa-kit/contact-core';
import * as food from '@huishouden/pwa-kit/food';
import * as push from '@huishouden/pwa-kit/push';
import * as reminder from '@huishouden/pwa-kit/reminder-core';
import * as spending from '@huishouden/pwa-kit/spending-core';
import * as todo from '@huishouden/pwa-kit/todo-core';
import * as visit from '@huishouden/pwa-kit/visit';

// The kit's `*_FIELDS` lists against the rules' `hasOnly` lists, field for field. The kit writes a
// document with exactly its list; the rules accept exactly theirs. When the two differ, a field the
// kit writes is refused (or one the rules allow is never written), and nothing else notices.
//
// Each list is found by `after`, a literal that occurs once in the rules (a `match` or `function`
// header, or a guard such as `docId == 'food'`), then the first `<on>.hasOnly([...])` after it.
const rules = readFileSync(resolve(__dirname, '../firestore.rules'), 'utf8');

const DATA = 'request.resource.data.keys()';
const CHANGED = 'request.resource.data.diff(resource.data).affectedKeys()';

const CONTRACT: { kit: string; fields: readonly string[]; after: string; on: string }[] = [
  { kit: 'spending-core TRANSACTION_FIELDS', fields: spending.TRANSACTION_FIELDS, after: 'match /spendingTransactions/{txId} {', on: DATA },
  { kit: 'contact-core CONTACT_PAY_FIELDS', fields: contact.CONTACT_PAY_FIELDS, after: 'match /contactPay/{contactId} {', on: DATA },
  { kit: 'contact-core CONTACT_FIELDS', fields: contact.CONTACT_FIELDS, after: 'match /contacts/{contactId} {', on: DATA },
  { kit: 'reminder-core REMINDER_FIELDS', fields: reminder.REMINDER_FIELDS, after: 'match /reminders/{reminderId} {', on: DATA },
  { kit: 'agenda-core SERIES_FIELDS', fields: agenda.SERIES_FIELDS, after: 'function agendaExport(d) {', on: 'd.series.keys()' },
  { kit: 'agenda-core AGENDA_FIELDS', fields: agenda.AGENDA_FIELDS, after: 'match /agenda/{itemId} {', on: DATA },
  { kit: 'todo-core TODO_ACTION_FIELDS', fields: todo.TODO_ACTION_FIELDS, after: 'function todoActionShape(a) {', on: 'a.keys()' },
  { kit: 'todo-core TODO_FIELDS', fields: todo.TODO_FIELDS, after: 'match /todos/{todoId} {', on: DATA },
  { kit: 'visit VISIT_FIELDS', fields: visit.VISIT_FIELDS, after: 'function visitShape(d) {', on: 'd.keys()' },
  { kit: 'visit VISIT_MARK_FIELDS', fields: visit.VISIT_MARK_FIELDS, after: 'match /visits/{visitId} {', on: CHANGED },
  { kit: 'visit VISIT_NOTE_FIELDS', fields: visit.VISIT_NOTE_FIELDS, after: 'match /visitNotes/{visitId} {', on: DATA },
  { kit: 'agenda-core PERSONAL_AGENDA_FIELDS', fields: agenda.PERSONAL_AGENDA_FIELDS, after: 'match /personalAgenda/{itemId} {', on: DATA },
  { kit: 'todo-core PERSONAL_TODO_FIELDS', fields: todo.PERSONAL_TODO_FIELDS, after: 'match /personalTodos/{todoId} {', on: DATA },
  { kit: 'reminder-core PERSONAL_REMINDER_FIELDS', fields: reminder.PERSONAL_REMINDER_FIELDS, after: 'match /personalReminders/{reminderId} {', on: DATA },
  { kit: 'calendar-export CALENDAR_SETTINGS_FIELDS', fields: calendarExport.CALENDAR_SETTINGS_FIELDS, after: 'match /calendarSettings/{email} {', on: DATA },
  { kit: 'push NOTIFICATION_PREFS_FIELDS', fields: push.NOTIFICATION_PREFS_FIELDS, after: 'match /notificationPrefs/{email} {', on: DATA },
  { kit: 'push PUSH_SUBSCRIPTION_FIELDS', fields: push.PUSH_SUBSCRIPTION_FIELDS, after: 'match /pushSubscriptions/{subId} {', on: DATA },
  { kit: 'food FOOD_FIELDS', fields: food.FOOD_FIELDS, after: "docId == 'food'", on: DATA },
];

// Lists the rules don't check field by field, each with the reason.
const UNCHECKED: Record<string, string> = {
  // Up to 20 people do not fit in a request's 1000 expressions: the rules check the shape and the
  // kit clips each person to FOOD_PERSON_FIELDS (the comment above `hhWords` in the rules).
  'food FOOD_PERSON_FIELDS': 'per person, too many expressions for the rules',
};

// Every exported `*_FIELDS` list in the installed kit, by module, from its declarations.
const KIT_DIST = resolve(__dirname, '../node_modules/@huishouden/pwa-kit/dist');
const exported = readdirSync(KIT_DIST).filter((f) => f.endsWith('.d.ts')).flatMap((f) =>
  [...readFileSync(resolve(KIT_DIST, f), 'utf8').matchAll(/export declare const (\w+_FIELDS):/g)].map((m) => `${f.slice(0, -5)} ${m[1]}`));

function rulesList(after: string, on: string): string[] {
  const start = rules.indexOf(after);
  expect(start, `"${after}" in firestore.rules`).toBeGreaterThanOrEqual(0);
  expect(rules.indexOf(after, start + 1), `"${after}" once in firestore.rules`).toBe(-1);
  const at = rules.indexOf(`${on}.hasOnly([`, start);
  expect(at, `${on}.hasOnly([...]) after "${after}"`).toBeGreaterThan(start);
  const body = rules.slice(at + on.length + '.hasOnly(['.length, rules.indexOf('])', at));
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe("the kit's field lists match the rules", () => {
  it.each(CONTRACT)('$kit', ({ fields, after, on }) => {
    expect([...rulesList(after, on)].sort()).toEqual([...fields].sort());
  });

  it('every *_FIELDS list the kit exports is checked here or named as unchecked', () => {
    expect(exported.length).toBeGreaterThan(0);
    const covered = new Set([...CONTRACT.map((c) => c.kit), ...Object.keys(UNCHECKED)]);
    expect(exported.filter((k) => !covered.has(k))).toEqual([]);
  });
});
