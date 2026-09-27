-- DC Bill Desk — Supabase schema
-- One document table mirroring the claude.ai artifact db (collection/doc -> jsonb).
-- Access: signed-in users whose email is in public.app_users. Nothing for anon.
-- The allowlist rows are added by hand in the SQL editor (never committed):
--   insert into public.app_users(email) values ('you@example.com');

create table if not exists public.app_users (
  email text primary key
);
alter table public.app_users enable row level security;  -- no policies: not readable via the API
revoke all on public.app_users from anon, authenticated;

create or replace function public.is_app_user()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.app_users u
    where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke execute on function public.is_app_user() from public, anon;
grant execute on function public.is_app_user() to authenticated;

create table if not exists public.docs (
  col        text        not null,
  id         text        not null,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid                 default auth.uid(),
  primary key (col, id)
);
alter table public.docs enable row level security;
revoke all on public.docs from anon;
grant select, insert, update, delete on public.docs to authenticated;

drop policy if exists docs_select on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;
create policy docs_select on public.docs for select to authenticated using ((select public.is_app_user()));
create policy docs_insert on public.docs for insert to authenticated with check ((select public.is_app_user()));
create policy docs_update on public.docs for update to authenticated using ((select public.is_app_user())) with check ((select public.is_app_user()));
create policy docs_delete on public.docs for delete to authenticated using ((select public.is_app_user()));

create or replace function public.docs_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before update on public.docs
  for each row execute function public.docs_touch();

-- Firestore-style update(): shallow-merge top-level fields (creates the doc if missing).
-- security invoker, so RLS on public.docs still applies.
create or replace function public.doc_merge(p_col text, p_id text, p_patch jsonb)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  insert into public.docs as d (col, id, data)
  values (p_col, p_id, coalesce(p_patch, '{}'::jsonb))
  on conflict (col, id) do update set data = d.data || excluded.data
  returning d.data;
$$;
revoke execute on function public.doc_merge(text, text, jsonb) from public, anon;
grant execute on function public.doc_merge(text, text, jsonb) to authenticated;

-- live updates across devices
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'docs'
  ) then
    alter publication supabase_realtime add table public.docs;
  end if;
end $$;
