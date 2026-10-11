import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COVERAGE } from '@huishouden/pwa-kit/household-tools/coverage';

// Every collection under a household that these rules let someone write is listed in the kit's
// COVERAGE: covered by household tools (the connector and `hh data`), internal with the reason, or a
// gap with what is missing (pwa-kit STANDARD.md "Household tools"). A new collection fails here
// until it is listed, so its tool, or the reason it has none, comes with it.
const rules = readFileSync(resolve(__dirname, '../firestore.rules'), 'utf8').split('\n');

/** `lists`, `healthPeople/meds`: each collection under `match /households/{householdId}` whose own `allow` lines let someone create, update or write. */
function writableCollections(): string[] {
  const start = rules.findIndex((l) => /^\s*match \/households\/\{householdId\} \{/.test(l));
  expect(start).toBeGreaterThan(0);
  const base = rules[start].search(/\S/);
  const out: string[] = [];
  const parents: { indent: number; name: string }[] = [];
  for (let i = start + 1; i < rules.length; i++) {
    const line = rules[i];
    const indent = line.search(/\S/);
    if (indent >= 0 && indent <= base && line.trim() === '}') break;
    const m = /^\s*match \/(\w+)\/\{\w+\} \{/.exec(line);
    if (!m) continue;
    while (parents.length && parents[parents.length - 1].indent >= indent) parents.pop();
    const name = [...parents.map((p) => p.name), m[1]].join('/');
    parents.push({ indent, name });
    const own = [];
    for (let j = i + 1; j < rules.length; j++) {
      const l = rules[j];
      const at = l.search(/\S/);
      if (at >= 0 && at <= indent && l.trim().startsWith('}')) break;
      if (at === indent + 2 && /^\s*allow /.test(l)) own.push(l);
    }
    if (own.some((l) => /allow [^:]*\b(create|update|write)\b[^:]*:\s*if (?!false;)/.test(l))) out.push(name);
  }
  return out;
}

describe("the kit's household-tool coverage", () => {
  const writable = writableCollections();

  it('finds the collections', () => {
    expect(writable).toContain('items');
    expect(writable).toContain('healthPeople/meds');
    expect(writable.length).toBeGreaterThan(50);
  });

  it('lists every collection these rules let someone write', () => {
    expect(writable.filter((c) => !(c in COVERAGE))).toEqual([]);
  });

  it('lists no collection the rules no longer have', () => {
    expect(Object.keys(COVERAGE).filter((c) => !writable.includes(c))).toEqual([]);
  });
});
