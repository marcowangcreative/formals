# Formals — Setup

Static pages, one Supabase project. Families open a single link (`wedding-shot-list.html?e=slug`). That link is the only credential they have. The admin dashboard is a magic-link sign-in for an email you put on an allowlist.

`config.js` is the only file with the Supabase URL and the public anon key. Do not put the service role key or the database password in the repo or in that file.

## Before you run this on the live project

The first version of Formals shipped with row level security policies that let anyone holding the anon key read, update, and delete every event. The script below drops those policies.

Run the SQL and deploy the new HTML in the same sitting. Order:

1. Run the SQL. The site that is live right now will stop loading events, because it talks to the table directly.
2. Deploy these files (Vercel will pick up `main` once the pull request is merged, or deploy the branch).

Until the SQL has been run, the old policies are still in force no matter which HTML is deployed.

## 1. Run the SQL

Supabase dashboard → **SQL Editor** → **New query**. Paste the whole block and run it. It is safe to run again: it creates what is missing, adds the new columns, and replaces the policies.

```sql
-- Formals security model
-- Anon (the public key in config.js) cannot read or write the events table.
-- Family pages call get_event / save_event / save_progress for one slug.
-- Admin create, list, rename, lock, and delete require a signed-in email
-- that is listed in admin_allowlist.

create table if not exists public.events (
  slug text primary key,
  couple_names text,
  data jsonb not null default '{}'::jsonb,
  locked boolean not null default false,
  progress jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.events add column if not exists locked boolean not null default false;
alter table public.events add column if not exists progress jsonb not null default '{}'::jsonb;
alter table public.events alter column data set default '{}'::jsonb;
alter table public.events alter column data set not null;

create index if not exists events_updated_at_idx on public.events (updated_at desc);

alter table public.events enable row level security;

-- The allowlist is not readable through the API. am_admin() reads it as definer.
create table if not exists public.admin_allowlist (
  email text primary key,
  created_at timestamptz not null default now(),
  constraint admin_allowlist_email_lower check (
    email = lower(email) and position('@' in email) > 1
  )
);

alter table public.admin_allowlist enable row level security;

revoke all on table public.events from public, anon, authenticated;
revoke all on table public.admin_allowlist from public, anon, authenticated;
grant select, insert, update, delete on table public.events to authenticated;

-- Helpers live in a schema the Data API does not expose.
-- Do not add "private" under Project Settings → API → Exposed schemas.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

create or replace function private.slug_from_event_topic(topic text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when topic ~ '^event:[a-z0-9][a-z0-9-]{0,79}$'
      then substring(topic from 7)
    else null
  end;
$$;

create or replace function private.event_exists(p_slug text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.events e where e.slug = p_slug
  );
$$;

create or replace function private.events_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.updated_at := pg_catalog.now();
    return new;
  end if;

  -- Day-of checkmarks write `progress` only and must not look like a family edit.
  if new.data is distinct from old.data
     or new.couple_names is distinct from old.couple_names
     or new.locked is distinct from old.locked
     or new.slug is distinct from old.slug then
    new.updated_at := pg_catalog.now();
  else
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

create or replace function private.notify_event_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  topic text;
  payload jsonb;
begin
  topic := 'event:' || coalesce(new.slug, old.slug);
  if tg_op = 'DELETE' then
    payload := jsonb_build_object('op', 'DELETE', 'slug', old.slug);
  else
    payload := jsonb_build_object(
      'op', tg_op,
      'slug', new.slug,
      'couple_names', new.couple_names,
      'data', new.data,
      'locked', new.locked,
      'progress', new.progress,
      'updated_at', new.updated_at
    );
  end if;

  begin
    -- private => true must match the client channel config.
    perform realtime.send(
      payload => payload,
      event => 'sync',
      topic => topic,
      private => true
    );
  exception
    when others then
      raise warning 'formals realtime send failed: %', sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function private.slug_from_event_topic(text) from public;
revoke all on function private.event_exists(text) from public;
revoke all on function private.events_touch_updated_at() from public;
revoke all on function private.notify_event_change() from public;
grant execute on function private.slug_from_event_topic(text) to anon, authenticated;
grant execute on function private.event_exists(text) to anon, authenticated;
grant execute on function private.events_touch_updated_at() to authenticated;
grant execute on function private.notify_event_change() to authenticated;

create or replace function public.am_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_allowlist a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.get_event(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{0,79}$' then
    raise exception 'INVALID_SLUG' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'slug', e.slug,
    'couple_names', e.couple_names,
    'data', e.data,
    'locked', e.locked,
    'progress', e.progress,
    'updated_at', e.updated_at,
    'created_at', e.created_at
  )
  into result
  from public.events e
  where e.slug = p_slug;

  return result;
end;
$$;

create or replace function public.save_event(p_slug text, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
  key_count integer;
begin
  if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{0,79}$' then
    raise exception 'INVALID_SLUG' using errcode = '22023';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'INVALID_DATA' using errcode = '22023';
  end if;

  p_data := p_data
    - 'locked' - 'progress' - 'updatedAt' - 'updated_at'
    - 'couple_names' - 'coupleNames' - 'slug'
    - '__proto__' - 'constructor' - 'prototype';

  select count(*) into key_count from jsonb_object_keys(p_data);
  if key_count > 80 or octet_length(p_data::text) > 80000 then
    raise exception 'PAYLOAD_TOO_LARGE' using errcode = '22023';
  end if;

  update public.events
  set data = p_data
  where slug = p_slug
    and locked = false
  returning jsonb_build_object(
    'slug', slug,
    'updated_at', updated_at,
    'locked', locked
  ) into result;

  if result is not null then
    return result;
  end if;

  if exists (select 1 from public.events where slug = p_slug and locked) then
    raise exception 'EVENT_LOCKED' using errcode = 'P0001';
  end if;

  raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002';
end;
$$;

create or replace function public.save_progress(p_slug text, p_progress jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
  k text;
  n integer := 0;
begin
  if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{0,79}$' then
    raise exception 'INVALID_SLUG' using errcode = '22023';
  end if;
  if p_progress is null or jsonb_typeof(p_progress) <> 'object' then
    raise exception 'INVALID_PROGRESS' using errcode = '22023';
  end if;

  for k in select jsonb_object_keys(p_progress)
  loop
    n := n + 1;
    if n > 200
       or k !~ '^[A-Za-z0-9-][A-Za-z0-9_-]{0,39}$'
       or jsonb_typeof(p_progress -> k) <> 'boolean' then
      raise exception 'INVALID_PROGRESS' using errcode = '22023';
    end if;
  end loop;

  -- Allowed while the list is locked. Does not change data or updated_at.
  update public.events
  set progress = p_progress
  where slug = p_slug
  returning jsonb_build_object(
    'slug', slug,
    'progress', progress
  ) into result;

  if result is null then
    raise exception 'EVENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  return result;
end;
$$;

revoke all on function public.am_admin() from public, anon, authenticated;
revoke all on function public.get_event(text) from public, anon, authenticated;
revoke all on function public.save_event(text, jsonb) from public, anon, authenticated;
revoke all on function public.save_progress(text, jsonb) from public, anon, authenticated;

grant execute on function public.am_admin() to authenticated;
grant execute on function public.get_event(text) to anon, authenticated;
grant execute on function public.save_event(text, jsonb) to anon, authenticated;
grant execute on function public.save_progress(text, jsonb) to anon, authenticated;

drop policy if exists "anon read" on public.events;
drop policy if exists "anon insert" on public.events;
drop policy if exists "anon update" on public.events;
drop policy if exists "anon delete" on public.events;
drop policy if exists "admin select" on public.events;
drop policy if exists "admin insert" on public.events;
drop policy if exists "admin update" on public.events;
drop policy if exists "admin delete" on public.events;

create policy "admin select"
  on public.events
  for select
  to authenticated
  using ((select public.am_admin()));

create policy "admin insert"
  on public.events
  for insert
  to authenticated
  with check ((select public.am_admin()));

create policy "admin update"
  on public.events
  for update
  to authenticated
  using ((select public.am_admin()))
  with check ((select public.am_admin()));

create policy "admin delete"
  on public.events
  for delete
  to authenticated
  using ((select public.am_admin()));

drop trigger if exists events_touch_updated_at on public.events;
create trigger events_touch_updated_at
  before insert or update on public.events
  for each row execute function private.events_touch_updated_at();

drop trigger if exists events_notify on public.events;
create trigger events_notify
  after insert or update or delete on public.events
  for each row execute function private.notify_event_change();

-- Private realtime channel. Anon can listen only, and only on event:<slug>
-- for a slug that exists. Anon cannot publish, so a guessed topic cannot
-- inject a fake update into someone else's open phone.
drop policy if exists "formals read event broadcasts" on realtime.messages;
create policy "formals read event broadcasts"
  on realtime.messages
  for select
  to anon, authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and private.event_exists(private.slug_from_event_topic(realtime.topic()))
  );

notify pgrst, 'reload schema';
```

You do not need to turn on replication for the `events` table. Live updates are a database trigger that broadcasts on a private channel named `event:<slug>`. Postgres Changes are not used, because those would require a table-wide select policy.

If the `realtime.messages` policy fails, stop and fix that error before using the app. Saving would still work, but two phones would not see each other.

## 2. Put yourself on the allowlist

Replace the address, then run this on its own. The email must be lowercase. The check constraint rejects anything else.

```sql
insert into public.admin_allowlist (email)
values (lower('YOU@YOURDOMAIN.COM'))
on conflict (email) do nothing;
```

Use the same address you will sign in with. A signed-in user who is not on this list sees an empty dashboard and cannot create or delete anything.

## 3. Turn on magic-link sign-in

In the Supabase dashboard:

1. **Authentication → Sign In / Providers → Email**. Leave Email enabled. Magic link is part of the email provider.
2. **Authentication → Sign In / Providers**, or **Authentication → Settings**. Turn **Allow new users to sign up** off. The admin page also sends `shouldCreateUser: false`, so a stranger cannot register from the form.
3. **Authentication → Users → Add user**. Add the same email as in the allowlist. Turn on auto-confirm if the form offers it. With public sign-up off, the magic link only works for a user who already exists.
4. **Authentication → URL Configuration**.
   - Site URL: `https://formals.vercel.app`
   - Redirect URLs, add each of these:
     - `https://formals.vercel.app/admin.html`
     - `http://localhost:8080/admin.html`
     - `http://127.0.0.1:8080/admin.html`
5. Leave **Allow anonymous sign-ins** off.

The built-in Supabase mailer is enough for one photographer. It rate-limits quickly (a link about once a minute, and a low hourly cap). If a link never arrives, check spam, wait a minute, or add custom SMTP under **Authentication → Emails**.

Open the link in the same browser that asked for it. Supabase uses a one-time code stored in that browser.

## 4. Config

`config.js` already points at the current project. If you create a new Supabase project, replace the two values there and nowhere else:

```js
window.FORMALS = {
  SUPABASE_URL: 'https://YOUR_PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_ANON_KEY',
};
```

Project Settings → API. Copy the project URL and the **anon public** key. Leave the service role key in the dashboard.

## 5. Host it

There is no build step. Upload the folder, or let Vercel serve the repo.

- Admin: `https://formals.vercel.app/admin.html`
- Family list: `https://formals.vercel.app/wedding-shot-list.html?e=SLUG`
- Day-of call-out: `https://formals.vercel.app/wedding-shot-list.html?e=SLUG&view=dayof`

Opening the HTML files from Finder (`file://`) will not complete a magic link. For a local check, from this folder:

```bash
python3 -m http.server 8080
```

Then open `http://127.0.0.1:8080/admin.html`. The redirect URL has to be listed in step 3.

## How a wedding uses it

1. Sign in at `admin.html`. Create the couple. The slug is generated for you and is not shown in the table; use **Copy link**.
2. Send that link to the couple. Both families can edit. With the SQL applied, they see each other's names within a second or two.
3. When the list is finished, click **Lock**. The family page becomes read-only and shows **Last edited**. Day-of checkmarks still save, so the assistant can mark groups done at the venue.
4. **Unlock** if someone still needs to fix a name.
5. Open **Day-of** on the assistant's phone. One group, large type, previous, next, and a done check. The counter is the position in the list (`3 of 23`) plus how many are done. Arrow keys work on a laptop. Swipe works on a phone.
6. **Delete** is permanent and only available to an allowlisted admin. There is no anon delete.

Shot definitions live in `wedding-shot-list.html`. Names live in the database. Editing the HTML changes the template for every event the next time someone loads the page. Existing names stay.

## What the anon key can and cannot do

| Action | Who |
| --- | --- |
| Load one event by slug | Anyone with the link |
| Save names on that event | Anyone with the link, until it is locked |
| Mark day-of groups done | Anyone with the link, including after lock |
| List every event, create, rename, lock, delete | Signed-in email on `admin_allowlist` |
| Read the allowlist or another event's row | Nobody through the API |

The slug is unguessable, but it is still a secret. Don't put family links on the public wedding website.

## Common questions

**The admin page says the allowlist check failed.** The SQL in step 1 has not been run, or the API schema cache is stale. Run the script again. It ends with `notify pgrst, 'reload schema'`.

**The family page says setup is needed.** Same fix. The old table policies are gone and the new functions are not there yet, or the reverse.

**Magic link says the redirect URL is not allowed.** Add the exact admin URL under Authentication → URL Configuration. `https://formals.vercel.app/admin.html` and `https://formals.vercel.app/` are not the same entry.

**Two people edited the same name at once.** The last save wins for the whole name list. Day-of checkmarks are a separate column, so checking a group does not wipe names, and a name save does not wipe checks. Two assistants marking different groups at the same moment can still overwrite each other's checks.

**Can I export?** The family page still has **Print** (use the browser's Save as PDF) and **Copy as text**.
