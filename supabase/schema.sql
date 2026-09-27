-- DC Bill Desk — Supabase schema (single user, no login)
--
-- One document table mirroring the claude.ai artifact db (collection/doc -> jsonb).
-- The table itself is closed to the API. All access goes through SECURITY DEFINER
-- functions that require a secret "desk key"; only its SHA-256 hash is stored.
-- The key lives in the owner's private link (…/#k=<key>) and the browser's localStorage,
-- never in this repo. Add / rotate a key in the SQL editor:
--   insert into public.desk_keys(key_hash, note)
--   values (encode(sha256(convert_to('<key>', 'UTF8')), 'hex'), 'laptop+phone');
--   delete from public.desk_keys where note = 'old';   -- revoke

create table if not exists public.docs (
  col        text        not null,
  id         text        not null,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);
alter table public.docs enable row level security;       -- no policies: unreachable via the API
revoke all on public.docs from anon, authenticated;

create table if not exists public.desk_keys (
  key_hash   text primary key,
  note       text,
  created_at timestamptz not null default now()
);
alter table public.desk_keys enable row level security;  -- no policies: unreachable via the API
revoke all on public.desk_keys from anon, authenticated;

create or replace function public.docs_touch()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end; $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before update on public.docs
  for each row execute function public.docs_touch();

-- key check, raises 42501 when the key is wrong (internal: not callable via the API)
create or replace function public.desk_guard(p_key text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_key is null or not exists (
    select 1 from public.desk_keys
    where key_hash = encode(pg_catalog.sha256(convert_to(p_key, 'UTF8')), 'hex')
  ) then
    raise exception 'invalid desk key' using errcode = '42501';
  end if;
end; $$;
revoke execute on function public.desk_guard(text) from public, anon, authenticated;

create or replace function public.desk_check(p_key text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin perform public.desk_guard(p_key); return true; end; $$;

create or replace function public.desk_list(p_key text, p_col text)
returns table (id text, data jsonb) language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.desk_guard(p_key);
  return query select d.id, d.data from public.docs d where d.col = p_col order by d.id;
end; $$;

create or replace function public.desk_dump(p_key text)
returns table (col text, id text, data jsonb) language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.desk_guard(p_key);
  return query select d.col, d.id, d.data from public.docs d order by d.col, d.id;
end; $$;

create or replace function public.desk_set(p_key text, p_col text, p_id text, p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.desk_guard(p_key);
  insert into public.docs (col, id, data) values (p_col, p_id, coalesce(p_data, '{}'::jsonb))
  on conflict (col, id) do update set data = excluded.data;
end; $$;

-- Firestore-style update(): shallow-merge top-level fields (creates the doc if missing)
create or replace function public.desk_merge(p_key text, p_col text, p_id text, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  perform public.desk_guard(p_key);
  insert into public.docs as d (col, id, data) values (p_col, p_id, coalesce(p_patch, '{}'::jsonb))
  on conflict (col, id) do update set data = d.data || excluded.data
  returning d.data into r;
  return r;
end; $$;

create or replace function public.desk_delete(p_key text, p_col text, p_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.desk_guard(p_key);
  delete from public.docs where col = p_col and id = p_id;
end; $$;

-- restore: upsert [{col, id, data}, …]; returns rows written
create or replace function public.desk_import(p_key text, p_rows jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  perform public.desk_guard(p_key);
  insert into public.docs (col, id, data)
  select r->>'col', r->>'id', coalesce(r->'data', '{}'::jsonb)
  from jsonb_array_elements(p_rows) r
  on conflict (col, id) do update set data = excluded.data;
  get diagnostics n = row_count;
  return n;
end; $$;

do $$
declare f text;
begin
  foreach f in array array[
    'desk_check(text)', 'desk_list(text,text)', 'desk_dump(text)', 'desk_set(text,text,text,jsonb)',
    'desk_merge(text,text,text,jsonb)', 'desk_delete(text,text,text)', 'desk_import(text,jsonb)'
  ] loop
    execute format('revoke execute on function public.%s from public, authenticated', f);
    execute format('grant execute on function public.%s to anon', f);
  end loop;
end $$;
