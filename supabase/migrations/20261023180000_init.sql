-- Private profile for one signed-in user. Deletes are tombstones in facts, not row deletes.
-- Provenance columns are required so a fact cannot be stored without a source quote.

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_updated_at() from public, anon, authenticated;

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table public.imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  filename text not null,
  conversation_count integer not null check (conversation_count >= 0),
  message_count integer not null check (message_count >= 0),
  warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.imports (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_source_id text not null,
  conversation_title text not null default '',
  source_message_id text not null,
  role text not null check (role in ('user', 'assistant')),
  body text not null,
  created_at_source timestamptz,
  ordinal integer not null,
  unique (import_id, conversation_source_id, source_message_id)
);

create table public.facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  import_id uuid references public.imports (id) on delete set null,
  stable_key text not null,
  slot text not null,
  value text not null,
  statement text not null,
  kind text not null,
  sensitivity text not null check (sensitivity in ('none', 'health', 'intimate', 'financial')),
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  status text not null check (status in ('proposed', 'confirmed', 'needs_confirmation', 'superseded', 'tombstoned')),
  valid_from timestamptz,
  invalid_at timestamptz,
  superseded_by_key text,
  source_kind text not null default 'mined_history' check (source_kind = 'mined_history'),
  user_edited boolean not null default false,
  confirmation_reason text,
  polarity text not null check (polarity in ('assert', 'deny', 'move')),
  explicit_move boolean not null default false,
  provenance_conversation_id text not null,
  provenance_message_id text not null,
  provenance_quote text not null check (char_length(provenance_quote) > 0),
  provenance_start integer not null check (provenance_start >= 0),
  provenance_end integer not null check (provenance_end > provenance_start),
  provenance_ordinal integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, stable_key)
);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  stable_key text not null,
  action text not null check (action in ('extract', 'confirm', 'edit', 'delete', 'supersede', 'reject', 'hold')),
  detail jsonb not null,
  created_at timestamptz not null default now()
);

create index facts_user_status_idx on public.facts (user_id, status);
create index messages_import_ordinal_idx on public.messages (import_id, ordinal);
create index audit_user_created_idx on public.audit_log (user_id, created_at);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id) values (new.id);
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger facts_set_updated_at
  before update on public.facts
  for each row execute function public.set_updated_at();

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.imports enable row level security;
alter table public.messages enable row level security;
alter table public.facts enable row level security;
alter table public.audit_log enable row level security;

create policy profiles_select on public.profiles
  for select to authenticated using (user_id = auth.uid());
create policy profiles_update on public.profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy imports_select on public.imports
  for select to authenticated using (user_id = auth.uid());
create policy imports_insert on public.imports
  for insert to authenticated with check (user_id = auth.uid());
create policy imports_delete on public.imports
  for delete to authenticated using (user_id = auth.uid());

create policy messages_select on public.messages
  for select to authenticated using (user_id = auth.uid());
create policy messages_insert on public.messages
  for insert to authenticated with check (user_id = auth.uid());

create policy facts_select on public.facts
  for select to authenticated using (user_id = auth.uid());
create policy facts_insert on public.facts
  for insert to authenticated with check (user_id = auth.uid());
create policy facts_update on public.facts
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy audit_select on public.audit_log
  for select to authenticated using (user_id = auth.uid());
create policy audit_insert on public.audit_log
  for insert to authenticated with check (user_id = auth.uid());

revoke all on public.profiles from anon;
revoke all on public.imports from anon;
revoke all on public.messages from anon;
revoke all on public.facts from anon;
revoke all on public.audit_log from anon;

grant select, update on public.profiles to authenticated;
grant select, insert, delete on public.imports to authenticated;
grant select, insert on public.messages to authenticated;
grant select, insert, update on public.facts to authenticated;
grant select, insert on public.audit_log to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'memory-exports',
  'memory-exports',
  false,
  52428800,
  array['application/json', 'text/json', 'text/plain']
);

create policy memory_exports_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'memory-exports'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy memory_exports_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'memory-exports'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy memory_exports_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'memory-exports'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'memory-exports'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy memory_exports_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'memory-exports'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
