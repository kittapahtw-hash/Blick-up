# DC Bill Desk (web)

A web tracker for DC expense work: bill collection, opening PO/IPO in iPro, submission to accounting before the 15th, plus routine SOP tasks and a cost ledger.
Moved from the claude.ai artifact version to a standalone site so it can be opened from any device.

- **Frontend:** a single static HTML page (`index.html`) plus `js/`, `css/`. No build step.
- **Backend:** Supabase (Postgres + Auth + Realtime).
- **Hosting:** Vercel (static)

> ⚠️ **This repo is public.** Never commit company data: Excel files, SOPs, JSON backups, emails or passwords.
> `.gitignore` already blocks `*.xlsx`, `*.docx`, `*backup*.json`, `db-snapshot/`. Real data lives only in Supabase.

## Structure

| File | Role |
|---|---|
| `index.html` | The whole app (UI + logic), copied from the artifact version with only the db connection changed |
| `js/store.js` | Data layer that emulates the old `db.doc().set/update/delete` and `db.collection().onSnapshot` API on Supabase, plus the login page and the backup/restore menu |
| `js/config.js` | Supabase URL + publishable key (**meant to be public**; data is protected by RLS) |
| `css/auth.css` | Login page and account menu |
| `supabase/schema.sql` | Tables, RLS, functions, realtime |
| `vercel.json` | Security headers + `noindex` |

## Data model

A single table, `public.docs(col, id, data jsonb)`, with the same shape as the artifact db:

- `templates/{id}`: job templates (bill / routine)
- `tasks/{templateId}__{YYYY-MM}` / `__W{YYYY-MM-DD}` / `__once`: per-period status
- `todos/{id}`: personal to-dos
- `ledger/meta`, `ledger/s1..s5`: cost ledger
- `ref/capex`, `ref/opex`: CAPEX/OPEX codes

`update()` goes through `doc_merge()`, which merges top-level fields (same semantics as Firestore `update`).

## Access control

- Users log in with email + password (Supabase Auth).
- RLS lets a user read/write `docs` only if their email is in `public.app_users` (the allowlist lives in the DB, not in the repo).
- `anon` has no access at all.
- Advisor warnings that are **intentional**: `app_users` has no policy (so nobody can read it through the API) and `is_app_user()` is callable by signed-in users (it only answers true/false for the caller).

### Adding a user

1. Supabase Dashboard → Authentication → Users → **Add user** (tick Auto Confirm)
2. SQL Editor: `insert into public.app_users(email) values ('name@example.com');`

Recommended: turn off public sign-ups (Authentication → Sign In / Providers → uncheck *Allow new users to sign up*). Even with sign-ups on, a user who isn't in the allowlist sees no data.

## Backup / restore

The **⋯** menu in the top-right corner:
- **Backup (JSON)**: downloads every document as one file. Do this at month-end and keep the file somewhere company-approved.
- **Restore from file**: upserts by id (existing ids are overwritten; docs not in the file are not deleted).

## Local development

```bash
npx http-server . -p 8080   # or python3 -m http.server 8080
```
Then open http://localhost:8080 (it connects to the real Supabase, so you need to be logged in).

## Setting up a new Supabase project

1. Create a project, then run `supabase/schema.sql` in the SQL Editor.
2. Put the URL + publishable key in `js/config.js`.
3. Add a user following the steps above, then use "Restore from file" to load the data.
