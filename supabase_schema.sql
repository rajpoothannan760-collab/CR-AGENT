-- =============================================================================
-- baileys_auth : persistent WhatsApp (Baileys) authentication state
-- Run once in the Supabase SQL Editor. Idempotent: safe to re-run.
--
--   id         '<session_id>:<key>'  e.g. 'default:creds', 'default:pre-key:12'
--   value      BufferJSON-serialized text (Buffers encoded as base64)
--   updated_at last write time
-- =============================================================================

create table if not exists public.baileys_auth (
  id         text        primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);

comment on table public.baileys_auth is
  'Baileys multi-device auth state. Contains PRIVATE KEYS - only the service_role key may access it.';

-- Keep updated_at fresh even if a writer forgets to set it.
create or replace function public.baileys_auth_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists baileys_auth_set_updated_at on public.baileys_auth;
create trigger baileys_auth_set_updated_at
  before update on public.baileys_auth
  for each row
  execute function public.baileys_auth_set_updated_at();

-- Fast prefix scans (used when a whole session is wiped after logout).
create index if not exists baileys_auth_id_prefix_idx
  on public.baileys_auth (id text_pattern_ops);

-- RLS enabled with NO policies: anon/authenticated are denied everything.
-- The bridge uses the service_role key, which bypasses RLS.
alter table public.baileys_auth enable row level security;

revoke all on table public.baileys_auth from anon, authenticated;
grant  all on table public.baileys_auth to service_role;
