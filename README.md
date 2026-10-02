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

Once the tests pass, every same-repo pull request also deploys its rules to the staging project
(`huishouden-staging`, invented data only), so an app's PR can be tried on staging against rules
that haven't merged yet; `main` deploys to staging too, so staging returns to the merged rules.
Staging carries whichever rules were deployed last. The staging deploy runs only once the repo has
the `STAGING_GCP_*` variables, which pwa-kit's `bootstrap.sh --staging` sets. See pwa-kit
STANDARD.md "Staging".

```sh
bun install
bun run test   # needs Java 21 for the emulator
```

Every block follows the same pattern: who may read and write (by role, below), an exact field
list (`keys().hasOnly([...])`), and type and size checks on each field.

## Roles

Each member has a role in the household document's `roles` map (`{ "<email>": "admin" }`). Anyone
it doesn't name is a member, except the household's creator (first in `members`), who is an admin.
`@huishouden/pwa-kit/roles` has the same table for the apps (`householdRole`, `can`, `useRole`).

| | Admin | Member | Helper | Kid |
|---|---|---|---|---|
| Invite and remove people, set roles (never their own) | yes | | | |
| Rename the household; settings, food preferences, portal layout, lists, cars, meal plan, medicine courses | yes | yes | | |
| Read lists, chores, pets, baby, home, car, contacts and appointments | yes | yes | yes | yes |
| Add items and log feeds, sleep, diapers, meals, readings and visits | yes | yes | yes | yes |
| Tick off anyone's item, chore, job, reminder or service, and Home's things to do before a regular event; end anyone's baby sleep | yes | yes | yes | yes |
| Change or delete what someone else added | yes | yes | own only | own only |
| Give pet medicine (dose logs) | yes | yes | if the course allows them | |
| Read or write Spending and Bills | yes | yes | | |
| Read contacts, appointments and agenda items marked private | yes | yes | | |

- Helpers and kids add records in their own name (`by` is their email) and may change or delete
  only those; on anyone's record they may change only the fields that tick it off.
- A medicine course's `givers` is `all` (every helper, the default) or `approved` (only the helpers
  in `approvedHelpers`).
- `private: true` hides a contact, appointment, agenda item or reminder from helpers and kids. A
  record without the flag is private to them until it is written with `private: false`, so their
  queries ask for `private == false`; the apps write the flag on every save.
- Reminders and agenda items are kept in step by whichever device opens an app, so helpers and kids
  may write the open ones, signed by them, linking only into the apps and never re-arming a sent
  reminder. Spending's and Bills' are always private, whoever writes them.
- Home's regular events (`homeEvents`) are everyday records: anyone adds their own; moving or
  skipping one occurrence (`exceptions`) changes the event, so it is for admins, members and
  whoever added it. Ticking off the thing to do before an occurrence (`homeEventPrep`,
  `<eventId>_<day>`) is open to everyone in their own name; Undo removes your own tick.
- Kids never tick off a medicine reminder (flea and tick, heartworm, deworming, medication): that
  records it given. Ticking a step on someone else's item keeps the number of steps.
