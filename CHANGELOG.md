# Changelog

## 1.1.0 (2026-10-05)

### Features

* **health:** visits (`healthPeople/{person}/visits`) and their notes (`visitNotes`). Every reader of the person reads visits. Admins and member carers (and the person, a member) add and change any; helper carers add their own and change only those. Any reader marks a visit Attended or Missed and answers its follow-up, with the mark always signed by whoever made it. Notes are for admins and member carers only. Emulator tests for every role.
