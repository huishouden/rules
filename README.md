# Huishouden rules

The Firestore security rules for every Huishouden app, with their emulator tests. Firebase allows
one rules file per project, so all apps share this one; it is the boundary that keeps each
household's information visible only to its members.

- `firestore.rules`: who may read and write what. Everything lives under
  `households/{householdId}`; members are listed on the household document by lowercase email.
- `firestore.indexes.json`: indexes the apps' queries need.
- `test/rules/`: emulator tests proving each rule (allowed access succeeds, the rest fails).

## Changing rules

An app that adds or changes data opens a pull request here with the rules block and tests next to
the others. CI runs the tests against the Firestore emulator; merging to `main` deploys the rules
and indexes (keyless, via the suite's deploy identity) only after the tests pass.

```sh
bun install
bun run test   # needs Java 21 for the emulator
```

Every block follows the same pattern: members only (`isMember()`), an exact field list
(`keys().hasOnly([...])`), and type and size checks on each field.
