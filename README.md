# DC Bill Desk (web)

A web tracker for DC expense work: bill collection, opening PO/IPO in iPro, submission to accounting before the 15th, plus routine SOP tasks and a cost ledger.
Moved from the claude.ai artifact version to a standalone site so it can be opened from any device.

- **Frontend:** a single static HTML page (`index.html`) plus `js/`, `css/`. No build step.
- **Backend:** Supabase (Postgres only, with no Auth or Realtime; access is controlled by a secret key in the link)
- **Hosting:** Vercel (static)

> ⚠️ **This repo is public.** Never commit company data: Excel files, SOPs, JSON backups, emails or passwords.
> `.gitignore` already blocks `*.xlsx`, `*.docx`, `*backup*.json`, `db-snapshot/`. Real data lives only in Supabase.

## Structure

| File | Role |
|---|---|
| `index.html` | The whole app (UI + logic), copied from the artifact version with only the db connection changed |
| `js/store.js` | Data layer that emulates the old `db.doc().set/update/delete` and `db.collection().onSnapshot` API through the `desk_*` RPCs, plus the key-entry page and the backup/restore menu |
| `js/config.js` | Supabase URL + publishable key (**meant to be public**; the key alone is useless without the desk key) |
| `css/auth.css` | Key-entry page and ⋯ menu |
| `supabase/schema.sql` | Tables + `desk_*` functions |
| `vercel.json` | Security headers + `noindex` |

## Data model

A single table, `public.docs(col, id, data jsonb)`, with the same shape as the artifact db:

- `templates/{id}`: job templates (bill / routine)
- `tasks/{templateId}__{YYYY-MM}` / `__W{YYYY-MM-DD}` / `__once`: per-period status
- `todos/{id}`: personal to-dos
- `ledger/meta`, `ledger/s1..s5`: cost ledger
- `ref/capex`, `ref/opex`: CAPEX/OPEX codes

The "Import new Excel" button on the cost page reads the file in the browser (SheetJS). It fills merged cells into every cell they cover before reading (Excel keeps the value only in the top-left cell), treats rows under one merged vendor cell as a single group, and lists anything in the file worth checking (a row's Total left blank, a SUM range that misses rows, an annual total that doesn't match 12 months).

`update()` goes through `desk_merge()`, which merges top-level fields (same semantics as Firestore `update`).

## Access control (single user, no login)

- There is no login page. Access uses a **secret key embedded in a private link**: `https://dc-bill-desk.vercel.app/#k=<key>`
  - Open the link once per device and the key is saved to that browser's `localStorage` (and removed from the address bar immediately).
  - After that, just open `https://dc-bill-desk.vercel.app` normally.
  - The part after `#` is never sent to the server, so it doesn't show up in Vercel logs.
- The database stores only the SHA-256 **hash** of the key (`public.desk_keys`). The key itself is not in the repo.
- The `docs` table is completely closed to the API. Every read/write goes through `desk_*` functions that check the key first.
- Anyone who gets the link has full access. Treat it like a password: don't forward it or post it in group chats.
- No realtime: data resyncs when you switch back to the tab and every 60 seconds.

### Changing the key (if the link leaks)

Run this in the Supabase SQL Editor:

```sql
-- add the new key (generate a long random key yourself, e.g. python -c "import secrets;print(secrets.token_urlsafe(32))")
insert into public.desk_keys(key_hash, note)
values (encode(sha256(convert_to('<new key>', 'UTF8')), 'hex'), 'new');
-- revoke the old key
delete from public.desk_keys where note <> 'new';
```
Each device will ask for the key again once. Paste the new link, and you're done.

## Backup / restore

The **⋯** menu in the top-right corner:
- **Backup (JSON)**: downloads every document as one file. Do this at month-end and keep the file somewhere company-approved.
- **Restore from file**: upserts by id (existing ids are overwritten; docs not in the file are not deleted).

## Local development

```bash
npx http-server . -p 8080   # or python3 -m http.server 8080
```
Then open http://localhost:8080/#k=<key> (it connects to the real Supabase).

## Setting up a new Supabase project

1. Create a project, then run `supabase/schema.sql` in the SQL Editor.
2. Put the URL + publishable key in `js/config.js`.
3. Add a key following "Changing the key", open the link, then use "Restore from file" to load the data.
