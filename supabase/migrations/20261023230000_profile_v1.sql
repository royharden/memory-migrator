-- S18 memory-migrator: profile v1 schema, owner-read RLS and transactional RPCs.
-- Forward-only and data-preserving (PLAN §9): 20261023180000_init.sql is kept byte-for-byte
-- because the target/history could not be verified. This migration
--   * stops legacy direct writes and raw-message uploads (revokes grants/policies, keeps data),
--   * adds the new mm_* tables (quote evidence only, never full messages),
--   * exposes SECURITY DEFINER RPCs that derive the owner from auth.uid(), lock the profile row,
--     enforce revision/idempotency envelopes, suppression, review invariants and id-only events.
-- NOT APPLIED, NOT RUN (Dirty Mode). Runtime isolation, transactions and TS/SQL codec parity
-- (normalize/lower/\s vs JavaScript, JSON escaping, sort order) are deferred checks.

-- ---------------------------------------------------------------------------
-- 0. Legacy surface: keep rows, stop writes (delta items 1-3, 5)
-- ---------------------------------------------------------------------------
revoke insert, update, delete on public.imports, public.messages, public.facts, public.audit_log from anon, authenticated;
revoke update on public.profiles from anon, authenticated;
drop policy if exists imports_insert on public.imports;
drop policy if exists imports_delete on public.imports;
drop policy if exists messages_insert on public.messages;
drop policy if exists facts_insert on public.facts;
drop policy if exists facts_update on public.facts;
drop policy if exists audit_insert on public.audit_log;
drop policy if exists profiles_update on public.profiles;
-- Raw-export bucket: existing objects (if any) are retained pending an explicitly approved
-- retention decision; no new uploads or overwrites. Owners can still read/delete their objects.
drop policy if exists memory_exports_insert on storage.objects;
drop policy if exists memory_exports_update on storage.objects;

create schema if not exists mm_private;
revoke all on schema mm_private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.mm_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  next_event_seq bigint not null default 1,
  next_version_seq bigint not null default 1,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.mm_imports (
  id uuid primary key,
  user_id uuid not null,
  profile_id uuid not null,
  kind text not null check (kind in ('source', 'profile')),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  parser_version text check (parser_version is null or char_length(parser_version) <= 64),
  counts jsonb not null default '{}'::jsonb,
  applied_at timestamptz not null default now(),
  undone boolean not null default false,
  unique (id, user_id),
  foreign key (profile_id, user_id) references public.mm_profiles (id, user_id) on delete cascade
);

create table public.mm_facts (
  id uuid primary key,
  user_id uuid not null,
  profile_id uuid not null,
  current_revision integer not null check (current_revision >= 1),
  review text not null check (review in ('pending', 'approved', 'rejected')),
  approved_revision integer,
  lifecycle text not null check (lifecycle in ('live', 'hidden', 'erased')),
  superseded_reason text check (superseded_reason in ('changed_circumstance', 'corrected_error')),
  superseded_group uuid,
  superseded_effective date,
  sensitivity text[] not null default '{}' check (sensitivity <@ array['health', 'finance', 'intimate', 'belief', 'minors', 'precise_location']),
  sensitivity_confirmed_revision integer,
  first_seen timestamptz,
  last_seen timestamptz,
  scope_note text check (scope_note is null or char_length(scope_note) between 1 and 200),
  restored_from uuid,
  origin_profile_id text check (origin_profile_id is null or origin_profile_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  origin_generation_id text check (origin_generation_id is null or origin_generation_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  origin_revision integer check (origin_revision is null or origin_revision >= 1),
  created_at timestamptz not null default now(),
  row_version bigint not null default 1,
  unique (id, user_id),
  foreign key (profile_id, user_id) references public.mm_profiles (id, user_id) on delete cascade,
  check (approved_revision is null or review = 'approved')
);
create index mm_facts_profile_idx on public.mm_facts (profile_id, lifecycle);

create table public.mm_fact_revisions (
  fact_id uuid not null,
  user_id uuid not null,
  revision integer not null check (revision >= 1),
  slot text not null check (slot in ('identity.name', 'location.home', 'work.role', 'work.employer', 'preference.likes', 'preference.dislikes', 'health.note', 'financial.note')),
  value text check (value is null or char_length(value) between 1 and 280),
  polarity text not null check (polarity in ('assert', 'deny')),
  change_cue text not null check (change_cue in ('none', 'move', 'retraction', 'correction')),
  assertion text check (assertion is null or char_length(assertion) between 1 and 320),
  user_authored boolean not null,
  rule_id text check (rule_id is null or char_length(rule_id) <= 64),
  extractor_version text check (extractor_version is null or char_length(extractor_version) <= 64),
  created_at timestamptz not null default now(),
  primary key (fact_id, revision),
  foreign key (fact_id, user_id) references public.mm_facts (id, user_id) on delete cascade,
  check ((value is null) = (assertion is null))
);

create table public.mm_fact_evidence (
  id uuid primary key,
  user_id uuid not null,
  fact_id uuid not null,
  evidence_key text not null check (evidence_key ~ '^ev_[0-9a-f]{40}$'),
  source_digest text not null check (source_digest ~ '^[0-9a-f]{64}$'),
  conversation_id text not null check (char_length(conversation_id) between 1 and 256),
  message_id text not null check (char_length(message_id) between 1 and 256),
  role text not null check (role = 'user'),
  text_sha256 text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
  start_cp integer not null check (start_cp >= 0),
  end_cp integer not null check (end_cp > start_cp),
  quote text check (quote is null or (char_length(quote) <= 280 and char_length(quote) = end_cp - start_cp)),
  quote_sha256 text not null check (quote_sha256 ~ '^[0-9a-f]{64}$'),
  parser_version text not null check (parser_version in ('chatgpt-json/1')),
  source_time timestamptz,
  import_id uuid,
  added_at timestamptz not null default now(),
  unique (fact_id, evidence_key),
  foreign key (fact_id, user_id) references public.mm_facts (id, user_id) on delete cascade
);
create index mm_evidence_message_idx on public.mm_fact_evidence (user_id, conversation_id, message_id);

create table public.mm_fact_alias_keys (
  fact_id uuid not null,
  user_id uuid not null,
  key text not null check (key ~ '^[0-9a-f]{64}$'),
  primary key (fact_id, key),
  foreign key (fact_id, user_id) references public.mm_facts (id, user_id) on delete cascade
);
create index mm_alias_key_idx on public.mm_fact_alias_keys (user_id, key);

create table public.mm_import_occurrences (
  import_id uuid not null,
  user_id uuid not null,
  kind text not null check (kind in ('created_fact', 'added_link')),
  target_id uuid not null,
  primary key (import_id, kind, target_id),
  foreign key (import_id, user_id) references public.mm_imports (id, user_id) on delete cascade
);

create table public.mm_conflict_groups (
  id uuid primary key,
  user_id uuid not null,
  profile_id uuid not null,
  group_key_hash text not null check (group_key_hash ~ '^[0-9a-f]{64}$'),
  slot text not null,
  kind text not null check (kind in ('move', 'retraction', 'correction', 'changed', 'order_unknown')),
  state text not null check (state in ('open', 'resolved')),
  resolution jsonb,
  created_seq bigint not null,
  unique (id, user_id),
  foreign key (profile_id, user_id) references public.mm_profiles (id, user_id) on delete cascade
);

create table public.mm_conflict_members (
  group_id uuid not null,
  user_id uuid not null,
  fact_id uuid not null,
  revision integer not null,
  identity_key text not null,
  primary key (group_id, fact_id),
  foreign key (group_id, user_id) references public.mm_conflict_groups (id, user_id) on delete cascade,
  foreign key (fact_id, user_id) references public.mm_facts (id, user_id) on delete cascade
);

create table public.mm_tombstones (
  id uuid primary key,
  user_id uuid not null,
  profile_id uuid not null,
  generation_id text not null check (generation_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  mode text not null check (mode in ('erase', 'hide')),
  created_at timestamptz not null,
  unique (id, user_id),
  foreign key (profile_id, user_id) references public.mm_profiles (id, user_id) on delete cascade
);

create table public.mm_suppression_keys (
  tombstone_id uuid not null,
  user_id uuid not null,
  key text not null check (key ~ '^[0-9a-f]{64}$'),
  primary key (tombstone_id, key),
  foreign key (tombstone_id, user_id) references public.mm_tombstones (id, user_id) on delete cascade
);
create index mm_suppression_key_idx on public.mm_suppression_keys (user_id, key);

create table public.mm_restoration_relations (
  id uuid primary key,
  user_id uuid not null,
  profile_id uuid not null,
  key text not null check (key ~ '^[0-9a-f]{64}$'),
  fact_id uuid not null,
  restored_from uuid not null,
  open boolean not null default true,
  created_at timestamptz not null,
  foreign key (profile_id, user_id) references public.mm_profiles (id, user_id) on delete cascade,
  foreign key (fact_id, user_id) references public.mm_facts (id, user_id) on delete cascade,
  foreign key (restored_from, user_id) references public.mm_facts (id, user_id) on delete cascade
);

create table public.mm_profile_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  profile_id uuid not null,
  seq bigint not null,
  label text not null check (char_length(label) between 1 and 80),
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  include_sensitive boolean not null,
  profile_revision bigint not null,
  created_at timestamptz not null,
  unique (profile_id, seq),
  unique (id, user_id),
  foreign key (profile_id, user_id) references public.mm_profiles (id, user_id) on delete cascade
);

create table public.mm_version_items (
  version_id uuid not null,
  user_id uuid not null,
  ord integer not null,
  fact_id uuid not null,
  revision integer not null,
  primary key (version_id, ord),
  foreign key (version_id, user_id) references public.mm_profile_versions (id, user_id) on delete cascade,
  foreign key (fact_id, revision) references public.mm_fact_revisions (fact_id, revision)
);

create table public.mm_profile_events (
  profile_id uuid not null,
  user_id uuid not null,
  seq bigint not null,
  type text not null check (char_length(type) <= 40),
  ids text[] not null default '{}',
  counts jsonb,
  created_at timestamptz not null,
  primary key (profile_id, seq),
  foreign key (profile_id, user_id) references public.mm_profiles (id, user_id) on delete cascade
);

-- Idempotency: digest + minimal id/count result only. Never request bodies.
create table public.mm_request_log (
  user_id uuid not null,
  profile_id uuid not null,
  operation text not null,
  request_id uuid not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, profile_id, operation, request_id),
  foreign key (profile_id, user_id) references public.mm_profiles (id, user_id) on delete cascade
);

create table public.mm_applied_fingerprints (
  profile_id uuid not null,
  user_id uuid not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  primary key (profile_id, fingerprint),
  foreign key (profile_id, user_id) references public.mm_profiles (id, user_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- 2. RLS: authenticated owner reads only; no direct writes for anyone
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['mm_profiles', 'mm_imports', 'mm_facts', 'mm_fact_revisions', 'mm_fact_evidence', 'mm_fact_alias_keys',
    'mm_import_occurrences', 'mm_conflict_groups', 'mm_conflict_members', 'mm_tombstones', 'mm_suppression_keys',
    'mm_restoration_relations', 'mm_profile_versions', 'mm_version_items', 'mm_profile_events', 'mm_request_log', 'mm_applied_fingerprints']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))', t || '_owner_read', t);
  end loop;
end;
$$;
-- The request log is never needed by the browser.
revoke select on public.mm_request_log from authenticated;

-- ---------------------------------------------------------------------------
-- 3. Private helpers (not exposed; executed only inside the definer RPCs)
-- ---------------------------------------------------------------------------

-- Exact-match normalization: NFC, lowercase, collapsed whitespace, trimmed (parity with
-- normalizeExact() is a deferred runtime check: lower() and \s depend on the DB locale).
create function mm_private.norm(v text) returns text
language sql immutable set search_path = '' as $$
  select pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.normalize(v, NFC)), '\s+', ' ', 'g'), '^ | $', '', 'g')
$$;

create function mm_private.sha256_hex(v text) returns text
language sql immutable set search_path = '' as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v, 'UTF8')), 'hex')
$$;

-- Canonical {"polarity","slot","subject":"user","value"} -> identity/suppression key.
create function mm_private.identity_key(p_slot text, p_value text, p_polarity text) returns text
language sql immutable set search_path = '' as $$
  select mm_private.sha256_hex('{"polarity":' || pg_catalog.to_json(p_polarity)::text || ',"slot":' || pg_catalog.to_json(p_slot)::text
    || ',"subject":"user","value":' || pg_catalog.to_json(mm_private.norm(p_value))::text || '}')
$$;

create function mm_private.evidence_key(d text, c text, m text, t text, s integer, e integer) returns text
language sql immutable set search_path = '' as $$
  select 'ev_' || pg_catalog.left(mm_private.sha256_hex('[' || pg_catalog.to_json(d)::text || ',' || pg_catalog.to_json(c)::text || ',' || pg_catalog.to_json(m)::text
    || ',' || pg_catalog.to_json(t)::text || ',' || s::text || ',' || e::text || ']'), 40)
$$;

-- Server-side evidence shape checks (it cannot verify the original message without the source).
create function mm_private.evidence_error(e jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare q text := e ->> 'quote';
begin
  if jsonb_typeof(e) <> 'object' then return 'evidence must be an object'; end if;
  if q is null or char_length(q) = 0 then return 'quote is empty'; end if;
  if char_length(q) > 280 then return 'quote exceeds 280 code points'; end if;
  if (e ->> 'role') is distinct from 'user' then return 'evidence must come from a user message'; end if;
  if (e ->> 'parserVersion') is distinct from 'chatgpt-json/1' then return 'unsupported parser version'; end if;
  if coalesce(e ->> 'sourceDigest', '') !~ '^[0-9a-f]{64}$' or coalesce(e ->> 'textSha256', '') !~ '^[0-9a-f]{64}$' then return 'malformed hash'; end if;
  if jsonb_typeof(e -> 'start') <> 'number' or jsonb_typeof(e -> 'end') <> 'number' then return 'invalid offsets'; end if;
  if (e ->> 'start')::integer < 0 or (e ->> 'end')::integer - (e ->> 'start')::integer <> char_length(q) then return 'offset span does not match quote length'; end if;
  if mm_private.sha256_hex(q) is distinct from (e ->> 'quoteSha256') then return 'quote hash mismatch'; end if;
  if char_length(coalesce(e ->> 'conversationId', '')) not between 1 and 256 or char_length(coalesce(e ->> 'messageId', '')) not between 1 and 256 then return 'invalid ids'; end if;
  return null;
end;
$$;

create function mm_private.render_assertion(p_slot text, p_value text, p_polarity text) returns text
language sql immutable set search_path = '' as $$
  select case when p_polarity = 'assert' then
    case p_slot when 'identity.name' then 'Name is ' when 'location.home' then 'Lives in ' when 'work.role' then 'Works as '
      when 'work.employer' then 'Works at ' when 'preference.likes' then 'Likes ' when 'preference.dislikes' then 'Dislikes '
      when 'health.note' then 'Health note: ' else 'Financial note: ' end
  else
    case p_slot when 'identity.name' then 'Name is not ' when 'location.home' then 'Does not live in ' when 'work.role' then 'Does not work as '
      when 'work.employer' then 'Does not work at ' when 'preference.likes' then 'Does not like ' when 'preference.dislikes' then 'Does not dislike '
      when 'health.note' then 'Health note (denied): ' else 'Financial note (denied): ' end
  end || p_value
$$;

create function mm_private.is_suppressed(p_user uuid, p_key text) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.mm_suppression_keys s where s.user_id = p_user and s.key = p_key)
$$;

create function mm_private.open_restoration(p_user uuid, p_key text) returns uuid
language sql stable set search_path = '' as $$
  select r.fact_id from public.mm_restoration_relations r join public.mm_facts f on f.id = r.fact_id
  where r.user_id = p_user and r.key = p_key and r.open and f.lifecycle = 'live' limit 1
$$;

create function mm_private.event(p_profile uuid, p_user uuid, p_type text, p_ids text[], p_counts jsonb) returns void
language plpgsql set search_path = '' as $$
declare v_seq bigint;
begin
  update public.mm_profiles set next_event_seq = next_event_seq + 1 where id = p_profile returning next_event_seq - 1 into v_seq;
  insert into public.mm_profile_events (profile_id, user_id, seq, type, ids, counts, created_at) values (p_profile, p_user, v_seq, p_type, p_ids, p_counts, now());
end;
$$;

create function mm_private.bump(p_profile uuid) returns bigint
language sql set search_path = '' as $$
  update public.mm_profiles set revision = revision + 1 where id = p_profile returning revision
$$;

-- Envelope: owner from auth.uid(), profile row lock, payload digest/bounds, idempotency, revision.
-- Returns null to proceed, or a jsonb result to return immediately (replay or conflict).
create function mm_private.begin_request(p_op text, p_env jsonb, out o_user uuid, out o_profile uuid, out o_payload jsonb, out o_early jsonb)
language plpgsql set search_path = '' as $$
declare
  v_payload text := p_env ->> 'canonical_payload';
  v_sha text := p_env ->> 'payload_sha256';
  v_request uuid;
  v_expected bigint;
  v_current bigint;
  v_log public.mm_request_log;
begin
  o_user := auth.uid();
  if o_user is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if v_payload is null or v_sha is null or (p_env ->> 'request_id') is null then raise exception 'malformed envelope' using errcode = '22023'; end if;
  if octet_length(v_payload) > 1048576 then raise exception 'payload exceeds 1 MiB' using errcode = '54000'; end if;
  if mm_private.sha256_hex(v_payload) <> v_sha then raise exception 'payload digest mismatch' using errcode = '22023'; end if;
  v_request := (p_env ->> 'request_id')::uuid;
  v_expected := (p_env ->> 'expected_profile_revision')::bigint;
  select id, revision into o_profile, v_current from public.mm_profiles where user_id = o_user for update;
  if o_profile is null then raise exception 'profile missing; call mm_ensure_profile first' using errcode = 'P0002'; end if;
  -- Check an existing idempotency result before rejecting its now-old expected revision.
  select * into v_log from public.mm_request_log l where l.user_id = o_user and l.profile_id = o_profile and l.operation = p_op and l.request_id = v_request;
  if found then
    if v_log.payload_sha256 <> v_sha then
      o_early := jsonb_build_object('ok', false, 'code', 'idempotency_conflict', 'message', 'This request id was already used with a different payload.');
    else
      o_early := v_log.result || jsonb_build_object('replayed', true);
    end if;
    return;
  end if;
  if v_expected is distinct from v_current then
    o_early := jsonb_build_object('ok', false, 'code', 'conflict', 'message', 'The profile changed; reload and try again.', 'currentRevision', v_current);
    return;
  end if;
  o_payload := v_payload::jsonb;
end;
$$;

create function mm_private.finish_request(p_user uuid, p_profile uuid, p_op text, p_env jsonb, p_result jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare v_result jsonb := p_result || jsonb_build_object('revision', (select revision from public.mm_profiles where id = p_profile));
begin
  insert into public.mm_request_log (user_id, profile_id, operation, request_id, payload_sha256, result)
  values (p_user, p_profile, p_op, (p_env ->> 'request_id')::uuid, p_env ->> 'payload_sha256', v_result);
  return v_result;
end;
$$;

-- Full-state conflict groups (same contract as groups.ts).
create function mm_private.recompute_groups(p_profile uuid, p_user uuid) returns void
language plpgsql set search_path = '' as $$
declare
  k record;
  v_group public.mm_conflict_groups;
  v_kind text;
  v_still boolean;
  v_id uuid;
  v_touched text[] := '{}';
begin
  create temporary table if not exists mm_tmp_claims (fact_id uuid, slot text, target text, polarity text, cue text, last_seen timestamptz, revision integer, ikey text, gkey text) on commit drop;
  truncate mm_tmp_claims;
  insert into mm_tmp_claims
  select f.id, r.slot, mm_private.norm(r.value), r.polarity, r.change_cue, f.last_seen, r.revision,
    mm_private.identity_key(r.slot, r.value, r.polarity),
    case when r.slot in ('identity.name', 'location.home', 'work.role', 'work.employer') then r.slot
         when r.slot in ('preference.likes', 'preference.dislikes') then 'preference|' || mm_private.norm(r.value)
         else r.slot || '|' || mm_private.norm(r.value) end
  from public.mm_facts f join public.mm_fact_revisions r on r.fact_id = f.id and r.revision = f.current_revision
  where f.profile_id = p_profile and f.lifecycle = 'live' and f.review <> 'rejected' and f.superseded_reason is null and r.value is not null;

  for k in
    select a.gkey, array_agg(distinct x.fact_id order by x.fact_id) as members
    from mm_tmp_claims a join mm_tmp_claims b on a.gkey = b.gkey and a.fact_id < b.fact_id
    cross join lateral (values (a.fact_id), (b.fact_id)) as x(fact_id)
    where (a.slot = b.slot and a.slot in ('identity.name', 'location.home', 'work.role', 'work.employer') and (
             (a.polarity = 'assert' and b.polarity = 'assert' and a.target <> b.target) or (a.polarity <> b.polarity and a.target = b.target)))
       or (a.slot not in ('identity.name', 'location.home', 'work.role', 'work.employer') and a.target = b.target and (
             (a.slot = b.slot and a.polarity <> b.polarity)
             or (a.slot <> b.slot and a.polarity = 'assert' and b.polarity = 'assert' and array[a.slot, b.slot] @> array['preference.likes', 'preference.dislikes'])))
    group by a.gkey
  loop
    v_touched := v_touched || mm_private.sha256_hex(k.gkey);
    select case
      when bool_or(c.cue = 'move') then 'move'
      when bool_or(c.cue = 'correction') then 'correction'
      when bool_or(c.cue = 'retraction') or count(distinct c.polarity) > 1 then 'retraction'
      when bool_and(c.last_seen is not null) and count(distinct c.last_seen) = count(*) then 'changed'
      else 'order_unknown' end
    into v_kind from mm_tmp_claims c where c.fact_id = any (k.members);

    select * into v_group from public.mm_conflict_groups g where g.profile_id = p_profile and g.group_key_hash = mm_private.sha256_hex(k.gkey) order by g.created_seq desc limit 1;
    if found and v_group.state = 'resolved' and coalesce(v_group.resolution ->> 'decision', '') <> 'dissolved' then
      select bool_and(exists (
        select 1 from public.mm_conflict_members m where m.group_id = v_group.id and m.fact_id = c.fact_id and m.identity_key = c.ikey
          and (v_group.resolution -> 'kept') ? c.fact_id::text))
      into v_still from mm_tmp_claims c where c.fact_id = any (k.members);
      if v_still then continue; end if;
      update public.mm_conflict_groups set state = 'open', resolution = null, kind = v_kind where id = v_group.id;
      v_id := v_group.id;
      perform mm_private.event(p_profile, p_user, 'group_reopened', array[v_id::text], null);
    elsif found and v_group.state = 'open' then
      update public.mm_conflict_groups set kind = v_kind where id = v_group.id;
      v_id := v_group.id;
    else
      v_id := gen_random_uuid();
      insert into public.mm_conflict_groups (id, user_id, profile_id, group_key_hash, slot, kind, state, resolution, created_seq)
      values (v_id, p_user, p_profile, mm_private.sha256_hex(k.gkey), (select c.slot from mm_tmp_claims c where c.fact_id = k.members[1]), v_kind, 'open', null,
        (select coalesce(max(created_seq), 0) + 1 from public.mm_conflict_groups where profile_id = p_profile));
      perform mm_private.event(p_profile, p_user, 'group_opened', array[v_id::text], null);
    end if;
    delete from public.mm_conflict_members where group_id = v_id;
    insert into public.mm_conflict_members (group_id, user_id, fact_id, revision, identity_key)
    select v_id, p_user, c.fact_id, c.revision, c.ikey from mm_tmp_claims c where c.fact_id = any (k.members);
  end loop;

  for v_group in select * from public.mm_conflict_groups g where g.profile_id = p_profile and g.state = 'open' and not (g.group_key_hash = any (v_touched)) loop
    update public.mm_conflict_groups set state = 'resolved',
      resolution = jsonb_build_object('decision', 'dissolved', 'kept', '[]'::jsonb, 'displaced', '{}'::jsonb, 'scopeNote', null, 'effectiveDate', null, 'resolvedAt', now())
    where id = v_group.id;
    perform mm_private.event(p_profile, p_user, 'group_dissolved', array[v_group.id::text], null);
  end loop;
end;
$$;

-- Adds one evidence link if new. Returns the link id or null when it already existed.
create function mm_private.add_evidence(p_user uuid, p_fact uuid, p_e jsonb, p_import uuid) returns uuid
language plpgsql set search_path = '' as $$
declare v_key text; v_id uuid := gen_random_uuid();
begin
  v_key := mm_private.evidence_key(p_e ->> 'sourceDigest', p_e ->> 'conversationId', p_e ->> 'messageId', p_e ->> 'textSha256', (p_e ->> 'start')::integer, (p_e ->> 'end')::integer);
  insert into public.mm_fact_evidence (id, user_id, fact_id, evidence_key, source_digest, conversation_id, message_id, role, text_sha256, start_cp, end_cp, quote, quote_sha256, parser_version, source_time, import_id)
  values (v_id, p_user, p_fact, v_key, p_e ->> 'sourceDigest', p_e ->> 'conversationId', p_e ->> 'messageId', 'user', p_e ->> 'textSha256',
    (p_e ->> 'start')::integer, (p_e ->> 'end')::integer, p_e ->> 'quote', p_e ->> 'quoteSha256', p_e ->> 'parserVersion', (p_e ->> 'sourceTime')::timestamptz, p_import)
  on conflict (fact_id, evidence_key) do nothing;
  if not found then return null; end if;
  update public.mm_facts set first_seen = least(first_seen, (p_e ->> 'sourceTime')::timestamptz), last_seen = greatest(last_seen, (p_e ->> 'sourceTime')::timestamptz),
    row_version = row_version + 1 where id = p_fact and (p_e ->> 'sourceTime') is not null;
  return v_id;
end;
$$;

-- Live, non-erased facts must keep >= 1 evidence link with a quote.
create function mm_private.assert_evidence_invariant(p_profile uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.mm_facts f where f.profile_id = p_profile and f.lifecycle <> 'erased'
             and not exists (select 1 from public.mm_fact_evidence e where e.fact_id = f.id and e.quote is not null)) then
    raise exception 'evidence invariant violated' using errcode = '23514';
  end if;
end;
$$;

revoke all on all functions in schema mm_private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Public RPCs (SECURITY DEFINER, fixed search_path, owner from auth.uid())
-- ---------------------------------------------------------------------------
create function public.mm_ensure_profile() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_row public.mm_profiles;
begin
  if v_user is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  insert into public.mm_profiles (user_id) values (v_user) on conflict (user_id) do nothing;
  select * into v_row from public.mm_profiles where user_id = v_user;
  return jsonb_build_object('profileId', v_row.id, 'revision', v_row.revision);
end;
$$;

-- Section 8 transaction: tombstones first, then items (candidates or portable facts).
-- payload: {kind, fingerprint, parserVersion, originProfileId?, tombstones:[{id,generationId,keys,mode,at}],
--           items:[{slot,value,polarity,changeCue,userAuthored,ruleId,extractorVersion,sensitivity,evidence:[..],
--                   origin?:{profileId,generationId}, revision?}]}
create function public.mm_apply_import_plan(envelope jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  b record;
  v_import uuid := gen_random_uuid();
  t jsonb; it jsonb; e jsonb; k text;
  v_key text; v_target uuid; v_fact public.mm_facts; v_rev public.mm_fact_revisions;
  v_link uuid; v_tomb uuid; v_err text;
  v_created int := 0; v_attached int := 0; v_unchanged int := 0; v_suppressed int := 0; v_tombs int := 0; v_hidden int := 0;
  v_added int;
  v_own_tomb uuid;
  v_origin_rev integer;
  v_has_origin boolean;
  v_origin_profile text; v_origin_gen text; v_mapped uuid;
begin
  select * into b from mm_private.begin_request('apply_import_plan', envelope);
  if b.o_early is not null then return b.o_early; end if;
  if b.o_payload ->> 'kind' not in ('source', 'profile') or coalesce(b.o_payload ->> 'fingerprint', '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'bad_payload', 'message', 'Unknown import kind or fingerprint.');
  end if;
  if jsonb_array_length(coalesce(b.o_payload -> 'items', '[]')) > 500 then
    return jsonb_build_object('ok', false, 'code', 'too_large', 'message', 'At most 500 candidates per import.');
  end if;
  if exists (select 1 from public.mm_applied_fingerprints where profile_id = b.o_profile and fingerprint = b.o_payload ->> 'fingerprint') then
    return mm_private.finish_request(b.o_user, b.o_profile, 'apply_import_plan', envelope, jsonb_build_object('ok', true, 'noop', true));
  end if;
  v_origin_profile := b.o_payload ->> 'originProfileId';
  insert into public.mm_imports (id, user_id, profile_id, kind, fingerprint, parser_version) values (v_import, b.o_user, b.o_profile, b.o_payload ->> 'kind', b.o_payload ->> 'fingerprint', b.o_payload ->> 'parserVersion');

  -- 1. Imported tombstones: union; hide local live matches (restoration-relation rule applies).
  for t in select * from jsonb_array_elements(coalesce(b.o_payload -> 'tombstones', '[]')) loop
    if t ->> 'mode' not in ('erase', 'hide') or coalesce(t ->> 'generationId', '') !~ '^[A-Za-z0-9_.:-]{1,128}$' then
      raise exception 'invalid tombstone' using errcode = '22023';
    end if;
    select pm.id into v_mapped from public.mm_facts pm where pm.profile_id = b.o_profile and pm.origin_profile_id = v_origin_profile and pm.origin_generation_id = t ->> 'generationId';
    if v_mapped is null and v_origin_profile = b.o_profile::text then v_mapped := (select id from public.mm_facts where id::text = t ->> 'generationId' and profile_id = b.o_profile); end if;
    if exists (select 1 from public.mm_tombstones x where x.profile_id = b.o_profile and x.generation_id = coalesce(v_mapped::text, t ->> 'generationId') and x.mode = t ->> 'mode'
               and (select array_agg(s.key order by s.key) from public.mm_suppression_keys s where s.tombstone_id = x.id) = (select array_agg(v order by v) from jsonb_array_elements_text(t -> 'keys') v)) then
      continue;
    end if;
    v_tomb := gen_random_uuid();
    insert into public.mm_tombstones (id, user_id, profile_id, generation_id, mode, created_at) values (v_tomb, b.o_user, b.o_profile, coalesce(v_mapped::text, t ->> 'generationId'), t ->> 'mode', coalesce((t ->> 'at')::timestamptz, now()));
    for k in select * from jsonb_array_elements_text(t -> 'keys') loop
      if k !~ '^[0-9a-f]{64}$' then raise exception 'invalid tombstone key' using errcode = '22023'; end if;
      insert into public.mm_suppression_keys (tombstone_id, user_id, key) values (v_tomb, b.o_user, k) on conflict do nothing;
    end loop;
    v_tombs := v_tombs + 1;
    for v_fact in select f.* from public.mm_facts f where f.profile_id = b.o_profile and f.lifecycle = 'live'
        and exists (select 1 from public.mm_fact_alias_keys a where a.fact_id = f.id and a.key in (select jsonb_array_elements_text(t -> 'keys'))) loop
      if exists (select 1 from public.mm_restoration_relations r where r.fact_id = v_fact.id and r.open) then
        if v_mapped is distinct from v_fact.id then continue; end if;
        update public.mm_restoration_relations set open = false where fact_id = v_fact.id and open;
      end if;
      update public.mm_facts set lifecycle = 'hidden', approved_revision = null, review = case when review = 'approved' then 'pending' else review end, row_version = row_version + 1 where id = v_fact.id;
      -- Suppress every identity the hidden fact has had (edit aliases), like a local hide.
      v_own_tomb := gen_random_uuid();
      insert into public.mm_tombstones (id, user_id, profile_id, generation_id, mode, created_at) values (v_own_tomb, b.o_user, b.o_profile, v_fact.id::text, 'hide', now());
      insert into public.mm_suppression_keys (tombstone_id, user_id, key) select v_own_tomb, b.o_user, a.key from public.mm_fact_alias_keys a where a.fact_id = v_fact.id on conflict do nothing;
      v_hidden := v_hidden + 1;
    end loop;
  end loop;

  -- 2. Items.
  for it in select * from jsonb_array_elements(coalesce(b.o_payload -> 'items', '[]')) loop
    if it ->> 'slot' not in ('identity.name', 'location.home', 'work.role', 'work.employer', 'preference.likes', 'preference.dislikes', 'health.note', 'financial.note')
       or it ->> 'polarity' not in ('assert', 'deny') or char_length(coalesce(it ->> 'value', '')) not between 1 and 280
       or jsonb_array_length(coalesce(it -> 'evidence', '[]')) not between 1 and 50 then
      raise exception 'invalid item' using errcode = '22023';
    end if;
    for e in select * from jsonb_array_elements(it -> 'evidence') loop
      v_err := mm_private.evidence_error(e);
      if v_err is not null then raise exception 'invalid evidence: %', v_err using errcode = '22023'; end if;
    end loop;
    v_key := mm_private.identity_key(it ->> 'slot', it ->> 'value', it ->> 'polarity');
    v_origin_gen := it -> 'origin' ->> 'generationId';
    v_target := mm_private.open_restoration(b.o_user, v_key);
    if v_target is null then
      if mm_private.is_suppressed(b.o_user, v_key) then v_suppressed := v_suppressed + 1; continue; end if;
      select f.id into v_target from public.mm_facts f join public.mm_fact_alias_keys a on a.fact_id = f.id
      where f.profile_id = b.o_profile and f.lifecycle = 'live' and a.key = v_key limit 1;
    end if;
    if v_target is not null then
      v_added := 0;
      for e in select * from jsonb_array_elements(it -> 'evidence') loop
        v_link := mm_private.add_evidence(b.o_user, v_target, e, v_import);
        if v_link is not null then
          v_added := v_added + 1;
          insert into public.mm_import_occurrences (import_id, user_id, kind, target_id) values (v_import, b.o_user, 'added_link', v_link);
        end if;
      end loop;
      if v_added = 0 then v_unchanged := v_unchanged + 1; continue; end if;
      v_attached := v_attached + 1;
      -- A new occurrence of a displaced claim re-enters review; sensitivity never lowers.
      update public.mm_facts set
        superseded_reason = null, superseded_group = null, superseded_effective = null,
        review = case when superseded_reason is not null and review = 'approved' then 'pending' else review end,
        approved_revision = case when superseded_reason is not null then null else approved_revision end,
        sensitivity = (select coalesce(array_agg(distinct s order by s), '{}') from unnest(sensitivity || coalesce((select array_agg(x) from jsonb_array_elements_text(it -> 'sensitivity') x), '{}')) s),
        sensitivity_confirmed_revision = case when not (sensitivity @> coalesce((select array_agg(x) from jsonb_array_elements_text(it -> 'sensitivity') x), '{}')) then null else sensitivity_confirmed_revision end,
        row_version = row_version + 1
      where id = v_target;
      continue;
    end if;
    -- Foreign revision semantics (parity with portable.ts): a revision not newer than the mapped origin
    -- revision is stale; a newer one becomes a pending proposal WITHOUT taking over the origin mapping.
    v_has_origin := false;
    if v_origin_gen is not null and v_origin_profile is distinct from b.o_profile::text then
      select f.origin_revision into v_origin_rev from public.mm_facts f
      where f.profile_id = b.o_profile and f.origin_profile_id = v_origin_profile and f.origin_generation_id = v_origin_gen
      order by f.created_at limit 1;
      v_has_origin := found;
      if v_has_origin and coalesce((it -> 'origin' ->> 'revision')::integer, 0) <= coalesce(v_origin_rev, 0) then
        v_unchanged := v_unchanged + 1; -- stale foreign revision
        continue;
      end if;
    end if;
    v_target := gen_random_uuid();
    insert into public.mm_facts (id, user_id, profile_id, current_revision, review, lifecycle, sensitivity, origin_profile_id, origin_generation_id, origin_revision)
    values (v_target, b.o_user, b.o_profile, 1, 'pending', 'live',
      coalesce((select array_agg(distinct x order by x) from jsonb_array_elements_text(it -> 'sensitivity') x), '{}'),
      case when v_origin_gen is not null and v_origin_profile is distinct from b.o_profile::text and not v_has_origin then v_origin_profile end,
      case when v_origin_gen is not null and v_origin_profile is distinct from b.o_profile::text and not v_has_origin then v_origin_gen end,
      case when v_origin_gen is not null and v_origin_profile is distinct from b.o_profile::text and not v_has_origin then (it -> 'origin' ->> 'revision')::integer end);
    insert into public.mm_fact_revisions (fact_id, user_id, revision, slot, value, polarity, change_cue, assertion, user_authored, rule_id, extractor_version)
    values (v_target, b.o_user, 1, it ->> 'slot', it ->> 'value', it ->> 'polarity', coalesce(it ->> 'changeCue', 'none'),
      mm_private.render_assertion(it ->> 'slot', it ->> 'value', it ->> 'polarity'), coalesce((it ->> 'userAuthored')::boolean, false), it ->> 'ruleId', it ->> 'extractorVersion');
    insert into public.mm_fact_alias_keys (fact_id, user_id, key) values (v_target, b.o_user, v_key);
    insert into public.mm_import_occurrences (import_id, user_id, kind, target_id) values (v_import, b.o_user, 'created_fact', v_target);
    for e in select * from jsonb_array_elements(it -> 'evidence') loop
      v_link := mm_private.add_evidence(b.o_user, v_target, e, v_import);
      if v_link is not null then insert into public.mm_import_occurrences (import_id, user_id, kind, target_id) values (v_import, b.o_user, 'added_link', v_link); end if;
    end loop;
    v_created := v_created + 1;
  end loop;

  if v_created + v_attached + v_tombs = 0 then
    delete from public.mm_imports where id = v_import; -- true no-op: no import row, revision or event
    return mm_private.finish_request(b.o_user, b.o_profile, 'apply_import_plan', envelope, jsonb_build_object('ok', true, 'noop', true, 'suppressed', v_suppressed, 'unchanged', v_unchanged));
  end if;
  update public.mm_imports set counts = jsonb_build_object('created', v_created, 'attached', v_attached, 'unchanged', v_unchanged, 'suppressed', v_suppressed, 'tombstones', v_tombs, 'hidden', v_hidden) where id = v_import;
  insert into public.mm_applied_fingerprints (profile_id, user_id, fingerprint) values (b.o_profile, b.o_user, b.o_payload ->> 'fingerprint');
  perform mm_private.recompute_groups(b.o_profile, b.o_user);
  perform mm_private.assert_evidence_invariant(b.o_profile);
  perform mm_private.bump(b.o_profile);
  perform mm_private.event(b.o_profile, b.o_user, 'import_applied', array[v_import::text], jsonb_build_object('created', v_created, 'attached', v_attached, 'suppressed', v_suppressed, 'tombstones', v_tombs, 'hidden', v_hidden));
  return mm_private.finish_request(b.o_user, b.o_profile, 'apply_import_plan', envelope,
    jsonb_build_object('ok', true, 'importId', v_import, 'created', v_created, 'attached', v_attached, 'unchanged', v_unchanged, 'suppressed', v_suppressed, 'tombstones', v_tombs, 'hidden', v_hidden));
end;
$$;

-- Review operations: approve | reject | unreject | edit | confirm_sensitive | mark_not_sensitive | mark_sensitive
-- payload: {op, factId, value?, expectedFactRevision?, category?}
create function public.mm_review(envelope jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  b record; p jsonb; v_fact public.mm_facts; v_rev public.mm_fact_revisions; v_op text; v_key text; v_value text; v_new_sens text[];
  v_in_open boolean;
begin
  select * into b from mm_private.begin_request('review', envelope);
  if b.o_early is not null then return b.o_early; end if;
  p := b.o_payload; v_op := p ->> 'op';
  select * into v_fact from public.mm_facts where id = (p ->> 'factId')::uuid and user_id = b.o_user and profile_id = b.o_profile for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No such fact.'); end if;
  if v_fact.lifecycle <> 'live' then return jsonb_build_object('ok', false, 'code', 'not_live', 'message', 'Hidden or erased facts cannot be reviewed.'); end if;
  select * into v_rev from public.mm_fact_revisions where fact_id = v_fact.id and revision = v_fact.current_revision;
  v_in_open := exists (select 1 from public.mm_conflict_members m join public.mm_conflict_groups g on g.id = m.group_id where m.fact_id = v_fact.id and g.state = 'open');

  if v_op = 'approve' then
    if v_fact.superseded_reason is not null then return jsonb_build_object('ok', false, 'code', 'superseded', 'message', 'This fact was displaced in a resolved conflict.'); end if;
    if v_fact.review = 'rejected' then return jsonb_build_object('ok', false, 'code', 'rejected', 'message', 'Move this rejected fact back to pending first.'); end if;
    if v_in_open then return jsonb_build_object('ok', false, 'code', 'open_group', 'message', 'Resolve the conflict group first.'); end if;
    if not exists (select 1 from public.mm_fact_evidence e where e.fact_id = v_fact.id and e.quote is not null) then return jsonb_build_object('ok', false, 'code', 'no_evidence', 'message', 'No valid quote.'); end if;
    if v_fact.review = 'approved' and v_fact.approved_revision = v_fact.current_revision then
      return mm_private.finish_request(b.o_user, b.o_profile, 'review', envelope, jsonb_build_object('ok', true, 'noop', true));
    end if;
    update public.mm_facts set review = 'approved', approved_revision = current_revision, row_version = row_version + 1 where id = v_fact.id;
  elsif v_op = 'reject' then
    if v_in_open then return jsonb_build_object('ok', false, 'code', 'open_group', 'message', 'Use the conflict group decision.'); end if;
    if v_fact.review = 'rejected' then return mm_private.finish_request(b.o_user, b.o_profile, 'review', envelope, jsonb_build_object('ok', true, 'noop', true)); end if;
    update public.mm_facts set review = 'rejected', approved_revision = null, row_version = row_version + 1 where id = v_fact.id;
  elsif v_op = 'unreject' then
    if v_fact.review <> 'rejected' then return mm_private.finish_request(b.o_user, b.o_profile, 'review', envelope, jsonb_build_object('ok', true, 'noop', true)); end if;
    update public.mm_facts set review = 'pending', approved_revision = null, row_version = row_version + 1 where id = v_fact.id;
  elsif v_op = 'edit' then
    if (p ->> 'expectedFactRevision')::integer is distinct from v_fact.current_revision then return jsonb_build_object('ok', false, 'code', 'stale_revision', 'message', 'This fact changed; reload.'); end if;
    v_value := pg_catalog.regexp_replace(p ->> 'value', '^\s+|\s+$', '', 'g');
    if v_value is null or char_length(v_value) not between 1 and 280 then return jsonb_build_object('ok', false, 'code', 'bad_value', 'message', 'Wording must be 1-280 characters.'); end if;
    if v_value = v_rev.value then return mm_private.finish_request(b.o_user, b.o_profile, 'review', envelope, jsonb_build_object('ok', true, 'noop', true)); end if;
    v_key := mm_private.identity_key(v_rev.slot, v_value, v_rev.polarity);
    if exists (select 1 from public.mm_fact_alias_keys a join public.mm_facts f on f.id = a.fact_id where a.user_id = b.o_user and a.key = v_key and f.id <> v_fact.id and f.lifecycle = 'live') then
      return jsonb_build_object('ok', false, 'code', 'matches_other_fact', 'message', 'This wording matches another fact.');
    end if;
    if mm_private.is_suppressed(b.o_user, v_key) and mm_private.open_restoration(b.o_user, v_key) is distinct from v_fact.id then
      return jsonb_build_object('ok', false, 'code', 'suppressed', 'message', 'This wording matches an erased or hidden fact.');
    end if;
    insert into public.mm_fact_revisions (fact_id, user_id, revision, slot, value, polarity, change_cue, assertion, user_authored, rule_id, extractor_version)
    values (v_fact.id, b.o_user, v_fact.current_revision + 1, v_rev.slot, v_value, v_rev.polarity, v_rev.change_cue, mm_private.render_assertion(v_rev.slot, v_value, v_rev.polarity), true, null, null);
    insert into public.mm_fact_alias_keys (fact_id, user_id, key) values (v_fact.id, b.o_user, v_key) on conflict do nothing;
    -- Sensitivity is rechecked client-side by rules and sent as p.sensitivity; the server only ever raises it.
    v_new_sens := (select coalesce(array_agg(distinct s order by s), '{}') from unnest(v_fact.sensitivity || coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'sensitivity') x), '{}')) s
                   where s in ('health', 'finance', 'intimate', 'belief', 'minors', 'precise_location'));
    update public.mm_facts set current_revision = current_revision + 1, review = case when review = 'rejected' then 'rejected' else 'pending' end,
      approved_revision = null, sensitivity_confirmed_revision = null, sensitivity = v_new_sens, row_version = row_version + 1 where id = v_fact.id;
  elsif v_op = 'confirm_sensitive' then
    if cardinality(v_fact.sensitivity) = 0 then return jsonb_build_object('ok', false, 'code', 'not_sensitive', 'message', 'Not marked sensitive.'); end if;
    if v_fact.sensitivity_confirmed_revision = v_fact.current_revision then return mm_private.finish_request(b.o_user, b.o_profile, 'review', envelope, jsonb_build_object('ok', true, 'noop', true)); end if;
    update public.mm_facts set sensitivity_confirmed_revision = current_revision, row_version = row_version + 1 where id = v_fact.id;
  elsif v_op = 'mark_not_sensitive' then
    if cardinality(v_fact.sensitivity) = 0 then return mm_private.finish_request(b.o_user, b.o_profile, 'review', envelope, jsonb_build_object('ok', true, 'noop', true)); end if;
    update public.mm_facts set sensitivity = '{}', sensitivity_confirmed_revision = null, row_version = row_version + 1 where id = v_fact.id;
    v_op := 'sensitivity_lowered';
  elsif v_op = 'mark_sensitive' then
    if p ->> 'category' not in ('health', 'finance', 'intimate', 'belief', 'minors', 'precise_location') then return jsonb_build_object('ok', false, 'code', 'bad_category', 'message', 'Unknown category.'); end if;
    if (p ->> 'category') = any (v_fact.sensitivity) then return mm_private.finish_request(b.o_user, b.o_profile, 'review', envelope, jsonb_build_object('ok', true, 'noop', true)); end if;
    update public.mm_facts set sensitivity = (select array_agg(distinct s order by s) from unnest(sensitivity || array[p ->> 'category']) s), sensitivity_confirmed_revision = null, row_version = row_version + 1 where id = v_fact.id;
    v_op := 'sensitivity_raised';
  else
    return jsonb_build_object('ok', false, 'code', 'bad_op', 'message', 'Unknown review operation.');
  end if;
  perform mm_private.recompute_groups(b.o_profile, b.o_user);
  perform mm_private.bump(b.o_profile);
  perform mm_private.event(b.o_profile, b.o_user, v_op, array[v_fact.id::text], null);
  return mm_private.finish_request(b.o_user, b.o_profile, 'review', envelope, jsonb_build_object('ok', true));
end;
$$;

-- payload: {groupId, decision: keep_one|keep_several|reject_all, keep:[ids], displaced:{id:reason}, scopeNote?, effectiveDate?}
create function public.mm_resolve_group(envelope jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  b record; p jsonb; v_group public.mm_conflict_groups; v_decision text; v_keep uuid[]; m record; v_reason text; v_scope text; v_date date;
begin
  select * into b from mm_private.begin_request('resolve_group', envelope);
  if b.o_early is not null then return b.o_early; end if;
  p := b.o_payload; v_decision := p ->> 'decision';
  select * into v_group from public.mm_conflict_groups where id = (p ->> 'groupId')::uuid and user_id = b.o_user and profile_id = b.o_profile for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No such group.'); end if;
  if v_group.state <> 'open' then return jsonb_build_object('ok', false, 'code', 'not_open', 'message', 'Already resolved.'); end if;
  if nullif(p ->> 'effectiveDate', '') is not null then
    if (p ->> 'effectiveDate') !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok', false, 'code', 'bad_date', 'message', 'Effective date must be YYYY-MM-DD.'); end if;
    v_date := (p ->> 'effectiveDate')::date;
  end if;
  if v_decision = 'reject_all' then
    update public.mm_facts set review = 'rejected', approved_revision = null, row_version = row_version + 1 where id in (select fact_id from public.mm_conflict_members where group_id = v_group.id);
    v_keep := '{}';
  elsif v_decision in ('keep_one', 'keep_several') then
    v_keep := (select coalesce(array_agg(distinct x::uuid), '{}') from jsonb_array_elements_text(p -> 'keep') x);
    if (v_decision = 'keep_one' and cardinality(v_keep) <> 1) or (v_decision = 'keep_several' and cardinality(v_keep) < 2) then
      return jsonb_build_object('ok', false, 'code', 'bad_decision', 'message', 'Wrong number of kept facts.');
    end if;
    if exists (select 1 from unnest(v_keep) k where k not in (select fact_id from public.mm_conflict_members where group_id = v_group.id)) then
      return jsonb_build_object('ok', false, 'code', 'bad_decision', 'message', 'Kept facts must belong to the group.');
    end if;
    if v_decision = 'keep_several' then
      v_scope := pg_catalog.regexp_replace(coalesce(p ->> 'scopeNote', ''), '^\s+|\s+$', '', 'g');
      if char_length(v_scope) not between 1 and 200 then return jsonb_build_object('ok', false, 'code', 'bad_decision', 'message', 'Keep several needs a scope note.'); end if;
      update public.mm_facts set scope_note = v_scope, row_version = row_version + 1 where id = any (v_keep);
    end if;
    for m in select fact_id from public.mm_conflict_members where group_id = v_group.id and not (fact_id = any (v_keep)) loop
      v_reason := p -> 'displaced' ->> m.fact_id::text;
      if v_reason is null or v_reason not in ('changed_circumstance', 'corrected_error') then
        raise exception 'every displaced fact needs a reason' using errcode = '22023';
      end if;
      update public.mm_facts set superseded_reason = v_reason, superseded_group = v_group.id, superseded_effective = v_date, approved_revision = null,
        review = case when review = 'approved' then 'pending' else review end, row_version = row_version + 1 where id = m.fact_id;
    end loop;
  else
    return jsonb_build_object('ok', false, 'code', 'bad_decision', 'message', 'Unknown decision.');
  end if;
  update public.mm_conflict_members cm set revision = f.current_revision from public.mm_facts f where cm.group_id = v_group.id and f.id = cm.fact_id;
  update public.mm_conflict_groups set state = 'resolved', resolution = jsonb_build_object('decision', v_decision, 'kept', to_jsonb(v_keep::text[]),
    'displaced', (select coalesce(jsonb_object_agg(m.fact_id::text, p -> 'displaced' ->> m.fact_id::text), '{}'::jsonb)
                  from public.mm_conflict_members m where m.group_id = v_group.id and not (m.fact_id = any (v_keep)) and v_decision <> 'reject_all'),
    'scopeNote', v_scope, 'effectiveDate', v_date, 'resolvedAt', now()) where id = v_group.id;
  perform mm_private.recompute_groups(b.o_profile, b.o_user);
  perform mm_private.bump(b.o_profile);
  perform mm_private.event(b.o_profile, b.o_user, 'group_resolved', array[v_group.id::text], null);
  return mm_private.finish_request(b.o_user, b.o_profile, 'resolve_group', envelope, jsonb_build_object('ok', true));
end;
$$;

-- payload: {factId, mode: erase|hide, dependencyChoice: cascade|retain}
create function public.mm_delete_fact(envelope jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  b record; p jsonb; v_root public.mm_facts; v_ids uuid[]; v_deps uuid[]; v_prev int := -1; v_id uuid; v_tomb uuid;
  v_purged_rev int := 0; v_purged_q int := 0; v_n int; v_redacted bigint[]; v_tombs uuid[] := '{}';
  v_closed int := 0; v_hidden_q int := 0; v_groups uuid[];
begin
  select * into b from mm_private.begin_request('delete_fact', envelope);
  if b.o_early is not null then return b.o_early; end if;
  p := b.o_payload;
  if p ->> 'mode' not in ('erase', 'hide') or p ->> 'dependencyChoice' not in ('cascade', 'retain') then return jsonb_build_object('ok', false, 'code', 'bad_payload', 'message', 'Invalid mode.'); end if;
  select * into v_root from public.mm_facts where id = (p ->> 'factId')::uuid and user_id = b.o_user and profile_id = b.o_profile for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No such fact.'); end if;
  if v_root.lifecycle = 'erased' or (v_root.lifecycle = 'hidden' and p ->> 'mode' = 'hide') then return jsonb_build_object('ok', false, 'code', 'already_deleted', 'message', 'Already deleted.'); end if;

  -- Overlapping-quote dependencies (same message, intersecting code-point spans).
  v_ids := array[v_root.id];
  loop
    exit when cardinality(v_ids) = v_prev;
    v_prev := cardinality(v_ids);
    select coalesce(array_agg(distinct o.fact_id), '{}') into v_deps
    from public.mm_fact_evidence me join public.mm_fact_evidence o on o.user_id = me.user_id and o.conversation_id = me.conversation_id and o.message_id = me.message_id
      and o.start_cp < me.end_cp and me.start_cp < o.end_cp and o.fact_id <> me.fact_id and o.quote is not null
    join public.mm_facts f on f.id = o.fact_id and f.lifecycle <> 'erased'
    where me.fact_id = any (v_ids) and me.quote is not null and not (o.fact_id = any (v_ids));
    if p ->> 'dependencyChoice' = 'retain' then exit; end if;
    v_ids := v_ids || v_deps;
  end loop;
  if p ->> 'dependencyChoice' = 'retain' then v_deps := coalesce(v_deps, '{}'); else v_deps := '{}'; end if;

  foreach v_id in array v_ids loop
    v_tomb := gen_random_uuid();
    v_tombs := v_tombs || v_tomb;
    insert into public.mm_tombstones (id, user_id, profile_id, generation_id, mode, created_at) values (v_tomb, b.o_user, b.o_profile, v_id::text, p ->> 'mode', now());
    insert into public.mm_suppression_keys (tombstone_id, user_id, key) select v_tomb, b.o_user, a.key from public.mm_fact_alias_keys a where a.fact_id = v_id on conflict do nothing;
    update public.mm_restoration_relations set open = false where fact_id = v_id and open;
    get diagnostics v_n = row_count; v_closed := v_closed + v_n;
    if p ->> 'mode' = 'erase' then
      update public.mm_fact_revisions set value = null, assertion = null where fact_id = v_id and value is not null;
      get diagnostics v_n = row_count; v_purged_rev := v_purged_rev + v_n;
      update public.mm_fact_evidence set quote = null where fact_id = v_id and quote is not null;
      get diagnostics v_n = row_count; v_purged_q := v_purged_q + v_n;
      update public.mm_facts set lifecycle = 'erased', review = 'rejected', approved_revision = null, sensitivity = '{}', sensitivity_confirmed_revision = null,
        scope_note = null, superseded_reason = null, superseded_group = null, superseded_effective = null, row_version = row_version + 1 where id = v_id;
    else
      v_hidden_q := v_hidden_q + (select count(*) from public.mm_fact_evidence where fact_id = v_id and quote is not null);
      update public.mm_facts set lifecycle = 'hidden', approved_revision = null, review = case when review = 'approved' then 'pending' else review end, row_version = row_version + 1 where id = v_id;
    end if;
  end loop;
  select coalesce(array_agg(distinct m.group_id), '{}') into v_groups from public.mm_conflict_members m where m.fact_id = any (v_ids);
  if p ->> 'mode' = 'erase' then
    -- The keep_several note was copied onto every kept fact: clear it on surviving kept facts first.
    update public.mm_facts f set scope_note = null, row_version = row_version + 1
    where f.profile_id = b.o_profile and f.scope_note is not null and f.id in (
      select (k.value)::uuid from public.mm_conflict_groups g cross join lateral jsonb_array_elements_text(coalesce(g.resolution -> 'kept', '[]'::jsonb)) as k(value)
      where g.profile_id = b.o_profile and coalesce(g.resolution ->> 'scopeNote', '') <> ''
        and exists (select 1 from public.mm_conflict_members m where m.group_id = g.id and m.fact_id = any (v_ids)));
    update public.mm_conflict_groups g set resolution = jsonb_set(g.resolution, '{scopeNote}', 'null'::jsonb)
    where g.profile_id = b.o_profile and g.resolution ? 'scopeNote' and exists (select 1 from public.mm_conflict_members m where m.group_id = g.id and m.fact_id = any (v_ids));
  end if;
  select coalesce(array_agg(distinct v.seq order by v.seq), '{}') into v_redacted from public.mm_version_items i join public.mm_profile_versions v on v.id = i.version_id where i.fact_id = any (v_ids);
  perform mm_private.recompute_groups(b.o_profile, b.o_user);
  perform mm_private.bump(b.o_profile);
  perform mm_private.event(b.o_profile, b.o_user, p ->> 'mode', (select array_agg(x::text) from unnest(v_ids) x),
    jsonb_build_object('purgedRevisions', v_purged_rev, 'purgedQuotes', v_purged_q, 'retainedDependencies', cardinality(v_deps), 'redactedVersions', cardinality(v_redacted)));
  return mm_private.finish_request(b.o_user, b.o_profile, 'delete_fact', envelope, jsonb_build_object('ok', true, 'mode', p ->> 'mode',
    'generationIds', to_jsonb(v_ids::text[]), 'tombstoneIds', to_jsonb(v_tombs::text[]), 'purgedRevisions', v_purged_rev, 'purgedQuotes', v_purged_q,
    'retainedDependencies', to_jsonb(v_deps::text[]), 'redactedVersions', to_jsonb(v_redacted),
    'hiddenQuotes', v_hidden_q, 'closedRestorations', v_closed, 'recomputedGroups', to_jsonb(v_groups::text[])));
end;
$$;

-- payload: {oldId, reselected?: item (same shape as an import item, one evidence quote)}
create function public.mm_restore_fact(envelope jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  b record; p jsonb; v_old public.mm_facts; v_rev public.mm_fact_revisions; it jsonb; e jsonb; v_key text; v_new uuid := gen_random_uuid(); v_err text;
begin
  select * into b from mm_private.begin_request('restore_fact', envelope);
  if b.o_early is not null then return b.o_early; end if;
  p := b.o_payload;
  select * into v_old from public.mm_facts where id = (p ->> 'oldId')::uuid and user_id = b.o_user and profile_id = b.o_profile for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No such fact.'); end if;
  if v_old.lifecycle = 'live' then return jsonb_build_object('ok', false, 'code', 'not_deleted', 'message', 'Only hidden or erased facts can be restored.'); end if;
  if exists (select 1 from public.mm_restoration_relations where restored_from = v_old.id and open) then return jsonb_build_object('ok', false, 'code', 'already_restored', 'message', 'Already restored.'); end if;
  it := p -> 'reselected';
  if it is not null and jsonb_typeof(it) = 'object' then
    if jsonb_array_length(coalesce(it -> 'evidence', '[]')) <> 1 then raise exception 'one reselected quote required' using errcode = '22023'; end if;
    v_err := mm_private.evidence_error(it -> 'evidence' -> 0);
    if v_err is not null then return jsonb_build_object('ok', false, 'code', 'bad_evidence', 'message', v_err); end if;
    v_key := mm_private.identity_key(it ->> 'slot', it ->> 'value', it ->> 'polarity');
    if not exists (select 1 from public.mm_fact_alias_keys where fact_id = v_old.id and key = v_key) then
      return jsonb_build_object('ok', false, 'code', 'identity_mismatch', 'message', 'The reselected text does not match the deleted fact.');
    end if;
    insert into public.mm_facts (id, user_id, profile_id, current_revision, review, lifecycle, sensitivity, restored_from)
    -- Sensitivity never drops on restore: union the old classification with the reselected one.
    values (v_new, b.o_user, b.o_profile, 1, 'pending', 'live',
      (select coalesce(array_agg(distinct s order by s), '{}') from unnest(v_old.sensitivity || coalesce((select array_agg(x) from jsonb_array_elements_text(it -> 'sensitivity') x), '{}')) s
       where s in ('health', 'finance', 'intimate', 'belief', 'minors', 'precise_location')), v_old.id);
    insert into public.mm_fact_revisions (fact_id, user_id, revision, slot, value, polarity, change_cue, assertion, user_authored, rule_id, extractor_version)
    values (v_new, b.o_user, 1, it ->> 'slot', it ->> 'value', it ->> 'polarity', coalesce(it ->> 'changeCue', 'none'), mm_private.render_assertion(it ->> 'slot', it ->> 'value', it ->> 'polarity'), false, it ->> 'ruleId', it ->> 'extractorVersion');
    perform mm_private.add_evidence(b.o_user, v_new, it -> 'evidence' -> 0, null);
  else
    if v_old.lifecycle <> 'hidden' then return jsonb_build_object('ok', false, 'code', 'evidence_required', 'message', 'Erased facts need their source text reselected.'); end if;
    select * into v_rev from public.mm_fact_revisions where fact_id = v_old.id and revision = v_old.current_revision;
    v_key := mm_private.identity_key(v_rev.slot, v_rev.value, v_rev.polarity);
    insert into public.mm_facts (id, user_id, profile_id, current_revision, review, lifecycle, sensitivity, first_seen, last_seen, restored_from)
    values (v_new, b.o_user, b.o_profile, 1, 'pending', 'live', v_old.sensitivity, v_old.first_seen, v_old.last_seen, v_old.id);
    insert into public.mm_fact_revisions (fact_id, user_id, revision, slot, value, polarity, change_cue, assertion, user_authored, rule_id, extractor_version)
    values (v_new, b.o_user, 1, v_rev.slot, v_rev.value, v_rev.polarity, v_rev.change_cue, v_rev.assertion, v_rev.user_authored, v_rev.rule_id, v_rev.extractor_version);
    insert into public.mm_fact_evidence (id, user_id, fact_id, evidence_key, source_digest, conversation_id, message_id, role, text_sha256, start_cp, end_cp, quote, quote_sha256, parser_version, source_time, import_id)
    select gen_random_uuid(), user_id, v_new, evidence_key, source_digest, conversation_id, message_id, role, text_sha256, start_cp, end_cp, quote, quote_sha256, parser_version, source_time, null
    from public.mm_fact_evidence where fact_id = v_old.id and quote is not null;
  end if;
  if exists (select 1 from public.mm_fact_alias_keys a join public.mm_facts f on f.id = a.fact_id where a.user_id = b.o_user and a.key = v_key and f.lifecycle = 'live' and f.id <> v_new) then
    raise exception 'a live fact with the same wording exists' using errcode = '23505';
  end if;
  insert into public.mm_fact_alias_keys (fact_id, user_id, key) values (v_new, b.o_user, v_key);
  insert into public.mm_restoration_relations (id, user_id, profile_id, key, fact_id, restored_from, open, created_at) values (gen_random_uuid(), b.o_user, b.o_profile, v_key, v_new, v_old.id, true, now());
  perform mm_private.recompute_groups(b.o_profile, b.o_user);
  perform mm_private.assert_evidence_invariant(b.o_profile);
  perform mm_private.bump(b.o_profile);
  perform mm_private.event(b.o_profile, b.o_user, 'restore', array[v_new::text, v_old.id::text], null);
  return mm_private.finish_request(b.o_user, b.o_profile, 'restore_fact', envelope, jsonb_build_object('ok', true, 'factId', v_new));
end;
$$;

-- payload: {importId}
create function public.mm_undo_import(envelope jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  b record; v_import public.mm_imports; f record; l record; v_removed uuid[] := '{}'; v_removed_links int := 0; v_retained jsonb := '[]'; v_retained_links int := 0; v_reason text;
begin
  select * into b from mm_private.begin_request('undo_import', envelope);
  if b.o_early is not null then return b.o_early; end if;
  select * into v_import from public.mm_imports where id = (b.o_payload ->> 'importId')::uuid and user_id = b.o_user and profile_id = b.o_profile for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No such import.'); end if;
  if v_import.undone then return jsonb_build_object('ok', false, 'code', 'already_undone', 'message', 'Already undone.'); end if;
  for f in select x.* from public.mm_import_occurrences o join public.mm_facts x on x.id = o.target_id where o.import_id = v_import.id and o.kind = 'created_fact' loop
    v_reason := case
      when f.lifecycle <> 'live' then 'deleted later'
      when f.review <> 'pending' then 'reviewed (' || f.review || ')'
      when f.current_revision <> 1 then 'edited later'
      when exists (select 1 from public.mm_version_items i where i.fact_id = f.id) then 'referenced by a version'
      when f.superseded_reason is not null or f.scope_note is not null
        or exists (select 1 from public.mm_conflict_members m join public.mm_conflict_groups g on g.id = m.group_id
                   where m.fact_id = f.id and g.state = 'resolved' and coalesce(g.resolution ->> 'decision', '') <> 'dissolved') then 'resolved in a conflict group'
      when exists (select 1 from public.mm_fact_evidence e where e.fact_id = f.id and e.import_id is distinct from v_import.id) then 'also supported by another import'
      when exists (select 1 from public.mm_restoration_relations r where r.restored_from = f.id or r.fact_id = f.id) then 'restoration dependency'
      else null end;
    if v_reason is not null then
      v_retained := v_retained || jsonb_build_object('generationId', f.id, 'reason', v_reason);
    else
      delete from public.mm_conflict_members where fact_id = f.id;
      delete from public.mm_facts where id = f.id; -- cascades revisions/evidence/aliases
      v_removed := v_removed || f.id;
    end if;
  end loop;
  for l in select e.* from public.mm_import_occurrences o join public.mm_fact_evidence e on e.id = o.target_id where o.import_id = v_import.id and o.kind = 'added_link' loop
    if not exists (select 1 from public.mm_facts x where x.id = l.fact_id and x.lifecycle = 'live') then continue; end if;
    if not exists (select 1 from public.mm_fact_evidence e2 where e2.fact_id = l.fact_id and e2.id <> l.id and e2.quote is not null) then
      v_retained_links := v_retained_links + 1;
      continue;
    end if;
    delete from public.mm_fact_evidence where id = l.id;
    v_removed_links := v_removed_links + 1;
  end loop;
  update public.mm_imports set undone = true where id = v_import.id;
  delete from public.mm_applied_fingerprints where profile_id = b.o_profile and fingerprint = v_import.fingerprint;
  perform mm_private.recompute_groups(b.o_profile, b.o_user);
  perform mm_private.assert_evidence_invariant(b.o_profile);
  perform mm_private.bump(b.o_profile);
  perform mm_private.event(b.o_profile, b.o_user, 'undo_import', array[v_import.id::text], jsonb_build_object('removedGenerations', cardinality(v_removed), 'removedLinks', v_removed_links, 'retainedGenerations', jsonb_array_length(v_retained)));
  return mm_private.finish_request(b.o_user, b.o_profile, 'undo_import', envelope, jsonb_build_object('ok', true, 'importId', v_import.id,
    'removedGenerations', to_jsonb(v_removed::text[]), 'removedLinks', v_removed_links, 'retainedGenerations', v_retained, 'retainedLinks', v_retained_links));
end;
$$;

-- Server-selected projection + canonical bytes + digest in one transaction (PLAN §7).
-- payload: {label, includeSensitive, expectedDigest}
create function public.mm_publish_version(envelope jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  b record; v_inc boolean; v_label text; v_seq bigint; v_rows text; v_digest text; v_version uuid := gen_random_uuid(); v_count int;
begin
  select * into b from mm_private.begin_request('publish_version', envelope);
  if b.o_early is not null then return b.o_early; end if;
  v_inc := coalesce((b.o_payload ->> 'includeSensitive')::boolean, false);
  create temporary table if not exists mm_tmp_projection (fact_id uuid, revision integer, slot text, polarity text, value text, assertion text, user_authored boolean) on commit drop;
  truncate mm_tmp_projection;
  insert into mm_tmp_projection
  select f.id, r.revision, r.slot, r.polarity, r.value, r.assertion, r.user_authored
  from public.mm_facts f join public.mm_fact_revisions r on r.fact_id = f.id and r.revision = f.current_revision
  where f.profile_id = b.o_profile and f.lifecycle = 'live' and f.review = 'approved' and f.approved_revision = f.current_revision
    and f.superseded_reason is null and r.value is not null
    and not exists (select 1 from public.mm_fact_alias_keys a where a.fact_id = f.id and mm_private.is_suppressed(b.o_user, a.key)
                    and mm_private.open_restoration(b.o_user, a.key) is distinct from f.id)
    and not exists (select 1 from public.mm_conflict_members m join public.mm_conflict_groups g on g.id = m.group_id where m.fact_id = f.id and g.state = 'open')
    and exists (select 1 from public.mm_fact_evidence e where e.fact_id = f.id and e.quote is not null)
    and (cardinality(f.sensitivity) = 0 or (f.sensitivity_confirmed_revision = f.current_revision and v_inc));
  select count(*) into v_count from mm_tmp_projection;
  if v_count = 0 then return jsonb_build_object('ok', false, 'code', 'empty', 'message', 'No approved facts are eligible to publish.'); end if;
  -- Canonical v1 bytes: keys sorted, no whitespace, items ordered by id (byte order).
  select string_agg('{"assertion":' || to_json(t.assertion)::text || ',"id":' || to_json(t.fact_id::text)::text || ',"polarity":' || to_json(t.polarity)::text
      || ',"revision":' || t.revision::text || ',"slot":' || to_json(t.slot)::text || ',"userAuthored":' || case when t.user_authored then 'true' else 'false' end
      || ',"value":' || to_json(t.value)::text || '}', ',' order by t.fact_id::text collate "C")
  into v_rows from mm_tmp_projection t;
  v_digest := mm_private.sha256_hex('{"codecVersion":1,"format":"memory-migrator.version","includeSensitive":' || case when v_inc then 'true' else 'false' end || ',"items":[' || v_rows || ']}');
  -- Golden-byte parity gate: the browser sends the digest it computed over the same projection.
  -- The server never trusts it as the digest; a mismatch blocks publication visibly.
  if v_digest is distinct from (b.o_payload ->> 'expectedDigest') then
    return jsonb_build_object('ok', false, 'code', 'parity', 'message', 'Browser and server disagree on this version''s canonical bytes, so publication was blocked. Reload and try again; if it persists, the digest codec needs fixing.');
  end if;
  update public.mm_profiles set next_version_seq = next_version_seq + 1 where id = b.o_profile returning next_version_seq - 1 into v_seq;
  v_label := pg_catalog.regexp_replace(coalesce(b.o_payload ->> 'label', ''), '^\s+|\s+$', '', 'g');
  if v_label = '' then v_label := 'v' || v_seq::text; end if;
  insert into public.mm_profile_versions (id, user_id, profile_id, seq, label, digest, include_sensitive, profile_revision, created_at)
  values (v_version, b.o_user, b.o_profile, v_seq, left(v_label, 80), v_digest, v_inc, (select revision from public.mm_profiles where id = b.o_profile), date_trunc('second', now()));
  insert into public.mm_version_items (version_id, user_id, ord, fact_id, revision)
  select v_version, b.o_user, (row_number() over (order by t.fact_id::text collate "C"))::integer, t.fact_id, t.revision from mm_tmp_projection t;
  perform mm_private.bump(b.o_profile);
  perform mm_private.event(b.o_profile, b.o_user, 'publish_version', array[v_seq::text], jsonb_build_object('items', v_count));
  return mm_private.finish_request(b.o_user, b.o_profile, 'publish_version', envelope, jsonb_build_object('ok', true, 'seq', v_seq, 'digest', v_digest));
end;
$$;

revoke all on function public.mm_ensure_profile(), public.mm_apply_import_plan(jsonb), public.mm_review(jsonb), public.mm_resolve_group(jsonb),
  public.mm_delete_fact(jsonb), public.mm_restore_fact(jsonb), public.mm_undo_import(jsonb), public.mm_publish_version(jsonb) from public, anon;
grant execute on function public.mm_ensure_profile(), public.mm_apply_import_plan(jsonb), public.mm_review(jsonb), public.mm_resolve_group(jsonb),
  public.mm_delete_fact(jsonb), public.mm_restore_fact(jsonb), public.mm_undo_import(jsonb), public.mm_publish_version(jsonb) to authenticated;
