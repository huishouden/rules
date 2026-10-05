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

// Each list once, by module and name: the value compared is the one the name says.
const KIT = {
  'agenda-core': agenda, 'calendar-export': calendarExport, 'contact-core': contact, food, push,
  'reminder-core': reminder, 'spending-core': spending, 'todo-core': todo, visit,
} as const;
type Module = keyof typeof KIT;

const CONTRACT: { module: Module; name: string; after: string; on: string }[] = [
  { module: 'spending-core', name: 'TRANSACTION_FIELDS', after: 'match /spendingTransactions/{txId} {', on: DATA },
  { module: 'contact-core', name: 'CONTACT_PAY_FIELDS', after: 'match /contactPay/{contactId} {', on: DATA },
  { module: 'contact-core', name: 'CONTACT_FIELDS', after: 'match /contacts/{contactId} {', on: DATA },
  { module: 'reminder-core', name: 'REMINDER_FIELDS', after: 'match /reminders/{reminderId} {', on: DATA },
  { module: 'agenda-core', name: 'SERIES_FIELDS', after: 'function agendaExport(d) {', on: 'd.series.keys()' },
  { module: 'agenda-core', name: 'AGENDA_FIELDS', after: 'match /agenda/{itemId} {', on: DATA },
  { module: 'todo-core', name: 'TODO_ACTION_FIELDS', after: 'function todoActionShape(a) {', on: 'a.keys()' },
  { module: 'todo-core', name: 'TODO_FIELDS', after: 'match /todos/{todoId} {', on: DATA },
  { module: 'visit', name: 'VISIT_FIELDS', after: 'function visitShape(d) {', on: 'd.keys()' },
  { module: 'visit', name: 'VISIT_MARK_FIELDS', after: 'match /visits/{visitId} {', on: CHANGED },
  { module: 'visit', name: 'VISIT_NOTE_FIELDS', after: 'match /visitNotes/{visitId} {', on: DATA },
  { module: 'agenda-core', name: 'PERSONAL_AGENDA_FIELDS', after: 'match /personalAgenda/{itemId} {', on: DATA },
  { module: 'todo-core', name: 'PERSONAL_TODO_FIELDS', after: 'match /personalTodos/{todoId} {', on: DATA },
  { module: 'reminder-core', name: 'PERSONAL_REMINDER_FIELDS', after: 'match /personalReminders/{reminderId} {', on: DATA },
  { module: 'calendar-export', name: 'CALENDAR_SETTINGS_FIELDS', after: 'match /calendarSettings/{email} {', on: DATA },
  { module: 'push', name: 'NOTIFICATION_PREFS_FIELDS', after: 'match /notificationPrefs/{email} {', on: DATA },
  { module: 'push', name: 'PUSH_SUBSCRIPTION_FIELDS', after: 'match /pushSubscriptions/{subId} {', on: DATA },
  { module: 'food', name: 'FOOD_FIELDS', after: "docId == 'food'", on: DATA },
];

const fieldsOf = (module: Module, name: string): readonly string[] => {
  const v = (KIT[module] as Record<string, unknown>)[name];
  expect(Array.isArray(v), `${module} ${name} is an exported list`).toBe(true);
  return v as readonly string[];
};

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
  it.each(CONTRACT)('$module $name', ({ module, name, after, on }) => {
    expect([...rulesList(after, on)].sort()).toEqual([...fieldsOf(module, name)].sort());
  });

  it('every *_FIELDS list the kit exports is checked here or named as unchecked', () => {
    expect(exported.length).toBeGreaterThan(0);
    const covered = new Set([...CONTRACT.map((c) => `${c.module} ${c.name}`), ...Object.keys(UNCHECKED)]);
    expect(exported.filter((k) => !covered.has(k))).toEqual([]);
  });
});

// Agreeing is not enough: kit and rules could drift together. What the lists must keep regardless.
describe('the privacy the lists carry', () => {
  it('pay details never sit on the contact, which helpers and kids may read', () => {
    const shared = contact.CONTACT_FIELDS.filter((f) => (contact.CONTACT_PAY_FIELDS as readonly string[]).includes(f));
    expect(shared.sort()).toEqual(['by', 'updatedAt']);
  });

  it('every shared and personal agenda item, to-do, reminder and contact can be private', () => {
    for (const list of [contact.CONTACT_FIELDS, agenda.AGENDA_FIELDS, todo.TODO_FIELDS, reminder.REMINDER_FIELDS,
      agenda.PERSONAL_AGENDA_FIELDS, todo.PERSONAL_TODO_FIELDS, reminder.PERSONAL_REMINDER_FIELDS]) expect(list).toContain('private');
  });

  it('only the personal lists name an audience', () => {
    for (const list of [agenda.PERSONAL_AGENDA_FIELDS, todo.PERSONAL_TODO_FIELDS, reminder.PERSONAL_REMINDER_FIELDS]) expect(list).toContain('audience');
    for (const list of [agenda.AGENDA_FIELDS, todo.TODO_FIELDS, reminder.REMINDER_FIELDS]) expect(list).not.toContain('audience');
  });
});
