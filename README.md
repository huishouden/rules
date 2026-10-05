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

## Health and items for named people only

Health keeps people's medicines and visits, which only the household's admins, the person's carers and the person themself read:

| Path | Fields |
|---|---|
| `healthPeople/{person}` | name, birthDate, email (when the person is a member), carers, readers (the carers and the person), allergies, notes, createdAt, updatedAt, by |
| `healthPeople/{person}/photo/avatar` | data (WebP or JPEG data URL), updatedAt, by |
| `healthPeople/{person}/meds/{med}` | personId (the path's), name, strength, dose, doseAmount, doseUnit, asNeeded, times, everyDays, rule, minHours, maxPerDay, withFood, startDate, endDate, prescriberId, pharmacyId, refills, supply, supplyAt, refillOrderedAt, escalateMinutes, remind, notes, createdAt, updatedAt, by, via |
| `healthPeople/{person}/doses/{dose}` | personId (the path's), medId, slot (`YYYY-MM-DDTHH:MM`, none when as needed), at, status (`given`, `skipped`), note, by, createdAt, via |
| `healthPeople/{person}/visits/{visit}` | personId (the path's), kind (`checkup`, `specialist`, `dentist`, `eye`, `lab`, `vaccine`, `therapy`, `other`), title (none: the kind says it), at, allDay, minutes, contactId, location, link (https), prep (up to 6 lines), medList, remindBefore (up to 4 lead times in minutes, 0 to 20160), followUp (`{ every, unit: week or month }`), followUpOf, followUpDoneAt, status (`attended`, `missed`), markedAt, markedBy, calendarEventId, calendarLink, createdAt, updatedAt, by, via |
| `healthPeople/{person}/visitNotes/{visit}` | personId (the path's), text (up to 1000), updatedAt, by, via |

Everything under a person is checked against the person document by its path, so list queries
work: admins list `healthPeople` whole, everyone else with `where('readers', 'array-contains', me)`.
Kids never read health data, even if named.

Who does what with a person's visits (`@huishouden/pwa-kit/visit`):

| | Admins, member carers, the person (a member: they are in `readers`) | Helper carers | Other members, helpers, kids |
|---|---|---|---|
| Read a visit (when, where, doctor, what to bring) | yes | yes | no |
| Add a visit | yes | in their own name | no |
| Change or remove a visit | any | the ones they added | no |
| Mark Attended or Missed, answer its follow-up | yes, signed as themself (`markedBy`) | yes, signed as themself, only those fields | no |
| Read or write the notes (`visitNotes`) | yes | no | no |

A helper who takes someone to the dentist needs the time, the place and "fasting from midnight";
what the doctor said stays with the keepers. The notes never go into what Health publishes.

`personalAgenda`, `personalTodos` and `personalReminders` hold the agenda items, to-dos and
reminders for named members only (`@huishouden/pwa-kit/audience`): each names `audience`, and only
those members read, write (in their own name, among the audience) and remove it; queries ask for
`where('audience', 'array-contains', me)`. The shared sender reads `personalReminders` with the
collection-group indexes in `firestore.indexes.json`.

## AI assistants (huishouden/connector)

A member can use Huishouden from their own AI assistant through the connector, a Cloudflare Worker
that signs in as them and writes under these same rules. It never uses a service account for data.

- `via`: the records the connector creates may carry `via: 'assistant'`, and no other value. These
  are items, petFeedings, petDoses, petMedDoses, petAppointments, babyAppointments, carAppointments,
  homeEvents, homeServiceLog, contacts, and Health's meds, doses, visits and visit notes.
- `profiles/{email}` also takes `lang` (`en`, `es` or `nl`) and `timeZone` (an IANA name). The
  connector answers in that language and counts days in that zone.
- `connections/{grant}` is one connected assistant (`email`, `client`, `clientUri`, `createdAt`,
  `lastUsedAt`, `by`). Only its member reads, writes and removes it.
- `connections/{grant}/audit/{entry}` records each tool call (`tool`, `kind` read or write, `ok`,
  `app`, `ref`, `at`, `by`). Only the connection's member creates, reads and removes entries.
  Entries are never changed.

## Calendars (huishouden/calendar)

A member can see the household in their own calendar: a subscribed feed, or a "Huishouden" calendar
in their Google account that stays in sync both ways. The calendar Worker acts as the member under
these rules, like the connector.

- `agenda` and `personalAgenda` items may carry `series` (`rule`, `time`, `minutes`, `original`,
  `through`: the schedule an occurrence belongs to, so a calendar shows one repeating event) and
  `edit` (`reschedule`, `retime`, `rename`, `notes`, `skip`, `cancel`: the writes that carry a
  change made in the member's calendar back to the record), and `calendarDetail` (up to 200
  characters the portal never shows, for the reader's own calendar when they turn on detail: a
  Health dose's medicine names). The kit (`@huishouden/pwa-kit/agenda-core`)
  checks the contents and which collections an app's edits may touch; each write is made as the
  member and meets its own collection's rules.
- `calendarSettings/{email}`: what that member's calendar shows (`hiddenApps`, `todos`, `bills`,
  `healthDetail`, `done`, `updatedAt`, `by`). Only that member reads and writes it. Feed secrets and
  Google tokens are never in Firestore; the Worker keeps them encrypted in its own storage.
- `calendarChanges/{id}`: one change carried back from Google Calendar (`email`, `source: 'google'`,
  `app`, `ref`, `title`, `change`, `from`, `to`, `undo`, `at`, `by`). Only its member reads and
  removes it, and nobody changes it. The portal shows it with Undo, which writes `undo` as the member.
- `firestore.indexes.json` has `private` + `updatedAt` (agenda, todos) and `audience` + `updatedAt`
  (personalAgenda, personalTodos) for the Worker's change checks (a count and a sum of `updatedAt`).
- `spendingInboxes/{id}`: a Gmail account a member connected for Spending's card alerts, which the
  same Worker checks every few minutes as that member (`address`, `connectedAt`, `lastAlertAt`,
  `lastAdded`, `error`, `updatedAt`, `by`). Admins and members read it; it is written in the
  writer's own name; the member who connected it or an admin removes it. Google tokens and email
  content are never in Firestore: the alerts it finds are ordinary `spendingTransactions`
  (`source: 'alert'`) written as that member.

## Roles

Each member has a role in the household document's `roles` map (`{ "<email>": "admin" }`). Anyone
it doesn't name is a member, except the household's creator (first in `members`), who is an admin.
`@huishouden/pwa-kit/roles` has the same table for the apps (`householdRole`, `can`, `useRole`).

| | Admin | Member | Helper | Kid |
|---|---|---|---|---|
| Invite and remove people, set roles (never their own) | yes | | | |
| Read the household's home address (`home`) | yes | yes | yes | yes |
| Set or remove the household's home (`home`, in their own name) | yes | yes | | |
| Rename the household; settings, food preferences, portal layout, lists, cars, meal plan, medicine courses | yes | yes | | |
| Read lists, chores, pets, baby, home, car, contacts and appointments (not Health visits) | yes | yes | yes | yes |
| Add items and log feeds, sleep, diapers, meals, readings and visits | yes | yes | yes | yes |
| Tick off anyone's item, chore, job, reminder or service, and Home's things to do before a regular event; end anyone's baby sleep | yes | yes | yes | yes |
| Change or delete what someone else added | yes | yes | own only | own only |
| Give pet medicine (dose logs) | yes | yes | if the course allows them | |
| Read or write Spending and Bills | yes | yes | | |
| Read or write a contact's pay details (`contactPay`) | yes | yes | | |
| Read contacts, appointments and agenda items marked private | yes | yes | | |
| Health: read a person, their medicines and doses | yes | if a carer (or it is them) | if a carer | |
| Health: add or change a person and their medicines | yes | if a carer (or it is them) | | |
| Health: record a dose given or skipped; mark a refill ordered | yes | if a carer (or it is them) | if a carer (change own doses only) | |
| Health: read a visit (when, where, doctor, what to bring) | yes | if a carer (or it is them) | if a carer | |
| Health: add a visit; change or remove one | yes | if a carer (or it is them): any | if a carer: add, change own only | |
| Health: mark a visit Attended or Missed, answer its follow-up | yes | if a carer (or it is them), signed as themself | if a carer, signed as themself | |
| Health: read or write a visit's notes | yes | if a carer (or it is them) | | |
| Personal agenda items, to-dos and reminders | if named in `audience` | if named | if named | |

- Helpers and kids add records in their own name (`by` is their email) and may change or delete
  only those; on anyone's record they may change only the fields that tick it off.
- The household's `home` is `{ address, lat, lng, placeId?, timeZone?, approximate?, setBy, updatedAt }`
  on the household document (`@huishouden/pwa-kit/home`), so every member reads it with the
  household; `setBy` must be the writer. A contact may carry `lat` and `lng` (both, with its
  address) for "2.3 mi from home".
- A medicine course's `givers` is `all` (every helper, the default) or `approved` (only the helpers
  in `approvedHelpers`).
- `private: true` hides a contact, appointment, agenda item or reminder from helpers and kids. A
  record without the flag is private to them until it is written with `private: false`, so their
  queries ask for `private == false`; the apps write the flag on every save.
- A contact's pay details (Zelle, Venmo, bank, check address, portal link) are money, so they are
  never on the contact (which helpers and kids read when it is open) but in
  `contactPay/{contactId}`, for admins and members only, and only for a contact that exists.
- The to-do list (`todos`) is kept in step the same way. Each item's Done and Cancel are writes the
  portal makes as the member who taps them, so each is checked by its own collection's rules here.
  Cancelled things stay in their app's history: a cancelled to-do (`cancelledAt`), a paused Home job
  or car service (`pausedAt`), a closed car renewal (`closedAt`), a skipped baby checklist item, Home
  prep task or pet medicine dose (`skipped`), a dismissed pet reminder (`dismissedAt`), a skipped
  bill (`dismissed`). Setting them changes the record, so helpers and kids may do it only on what
  they added.
- Reminders and agenda items are kept in step by whichever device opens an app, so helpers and kids
  may write the open ones, signed by them, linking only into the apps and never re-arming a sent
  reminder. Spending's and Bills' are always private, whoever writes them.
- Home's regular events (`homeEvents`) are everyday records: anyone adds their own; moving or
  skipping one occurrence (`exceptions`) changes the event, so it is for admins, members and
  whoever added it. Ticking off the thing to do before an occurrence (`homeEventPrep`,
  `<eventId>_<day>`) is open to everyone in their own name; Undo removes your own tick.
- Kids never tick off a medicine reminder (flea and tick, heartworm, deworming, medication): that
  records it given. Ticking a step on someone else's item keeps the number of steps.

## License

Source available under [PolyForm Shield 1.0.0](LICENSE): you may use, study and modify this code
for any purpose except providing a product that competes with Huishouden.

Huishouden and its logo are the project's brand; please don't use them for other products.
