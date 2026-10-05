# Changelog

## [1.2.0](https://github.com/huishouden/rules/compare/v1.1.0...v1.2.0) (2026-10-05)

### Features

* **reminders:** source, what a reminder is about, for the sender to check ([043cf62](https://github.com/huishouden/rules/commit/043cf625b184b3b5c37d1a8f87672517b991c1fe))

### Bug Fixes

* **reminders:** a Health source only on a personal reminder, from a member or helper among the readers ([b046c49](https://github.com/huishouden/rules/commit/b046c493c1295511784847c030f1e8bc87f3e30a))
* **reminders:** a kid's device may write a source; the sender ignores it ([a17ff3a](https://github.com/huishouden/rules/commit/a17ff3a9d716ca2456dbe53e41f86f7a32166e15))
* **reminders:** a source names only its app's records, Health only for the person's readers ([accb824](https://github.com/huishouden/rules/commit/accb824924b9927a41dad8da704c7ccde488a6be))
* **reminders:** a source is signed by its writer and never a kid ([583b9be](https://github.com/huishouden/rules/commit/583b9be2361174a22ab5a282963025e0a6fc06b6))

## 1.1.0 (2026-10-05)

### Features

* **health:** visits (`healthPeople/{person}/visits`) and their notes (`visitNotes`). Every reader of the person reads visits. Admins and member carers (and the person, a member) add and change any; helper carers add their own and change only those. Any reader marks a visit Attended or Missed and answers its follow-up, with the mark always signed by whoever made it. Notes are for admins and member carers only. Emulator tests for every role.
