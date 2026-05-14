# Wedding Shot List — Setup Guide

This is a two-page tool for managing formal photo shot lists across multiple weddings, backed by Supabase.

- `wedding-shot-list.html` — what couples and family fill in
- `admin.html` — your dashboard to create events and grab shareable links

## 1. Create a Supabase project

1. Go to https://supabase.com and create a free account.
2. Click **New Project**. Pick any name (e.g. `wedding-shotlists`), set a database password (save it somewhere safe), and pick the region closest to you.
3. Wait ~2 minutes for it to provision.

## 2. Create the events table

In the Supabase dashboard, open **SQL Editor** → **New Query**, paste this in, and click **Run**:

```sql
-- Main table
create table events (
  slug text primary key,
  couple_names text,
  data jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

-- Row Level Security: anyone with the anon key can read/write.
-- Security model = unguessable slugs + admin passphrase on admin.html.
-- If you want stronger guarantees later, add Supabase Auth.
alter table events enable row level security;

create policy "anon read"   on events for select using (true);
create policy "anon insert" on events for insert with check (true);
create policy "anon update" on events for update using (true);
create policy "anon delete" on events for delete using (true);

-- Index for sorting by recency
create index events_updated_at_idx on events (updated_at desc);
```

## 3. Enable realtime (optional but recommended)

This is what makes the bride's mom on her phone see the groom's dad's edits live.

In the Supabase dashboard:
1. Go to **Database** → **Replication**.
2. Find the `events` table and toggle replication **on**.

## 4. Grab your project URL and anon key

In the Supabase dashboard:
1. Go to **Project Settings** → **API**.
2. Copy two values:
   - **Project URL** (looks like `https://abcxyz123.supabase.co`)
   - **anon public key** (a long string starting with `eyJ…`)

## 5. Paste them into both HTML files

In `wedding-shot-list.html`, find this near the top of the `<script>` block:

```js
const SUPABASE_URL = 'YOUR_SUPABASE_URL_HERE';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY_HERE';
```

Replace both strings. Then do the **same edit** in `admin.html` (the same two constants, same values).

## 6. Set your admin passphrase

In `admin.html`, find:

```js
const ADMIN_PASSPHRASE = 'changeme';
```

Change `changeme` to anything you want. This keeps random visitors out of the admin page. It's a soft gate, not real security — anyone determined who finds the URL can bypass it by reading the source. For 20 weddings of first-name data, that's fine. If you ever store real PII, switch to Supabase Auth.

## 7. Host it

You have three options, easiest first:

### Option A: Open the files directly (testing only)
Double-click `admin.html` from Finder. Works for testing but the shareable URLs will be `file:///Users/...` which won't work on phones.

### Option B: Netlify drop (recommended, takes 60 seconds)
1. Go to https://app.netlify.com/drop
2. Drag the folder containing both HTML files onto the page
3. You'll get a URL like `https://glowing-cat-123.netlify.app`
4. The admin page is at `…/admin.html`, shot lists are at `…/wedding-shot-list.html?e=slug`
5. Click **Site Settings** → **Domain management** to add a custom domain like `shotlists.marcowang.com` if you want

### Option C: Anywhere that serves static HTML
GitHub Pages, Vercel, Cloudflare Pages, your own server — anywhere works. No build step.

## How couples and families use it

1. From the admin page, you create an event for each couple (e.g. "Maria & David Bueso"). It generates an unguessable slug like `maria-and-david-bueso-k3m7`.
2. You copy the link and send it to the couple: `https://yourdomain.com/wedding-shot-list.html?e=maria-and-david-bueso-k3m7`
3. Both families open the link, fill in names. Edits sync in real time. They check off shots, add custom ones, print or copy the final list.
4. The day-of, the photographer's assistant pulls up the link and calls out names.

## Common questions

**Does each couple need an account?** No. The link itself is the credential.

**Can two people edit at the same time?** Yes — with realtime enabled (step 3), they see each other's changes within a second.

**What if someone shares the link publicly?** Anyone with the link can edit that event. Don't post the links on the public wedding website — share them by text or email.

**Is the free Supabase tier enough for 20 events a year?** Yes, by ~5000x. You'll use a few KB of storage and basically no bandwidth.

**Can I export a shot list as text/PDF?** The tool already has a "Print Shot List" button (browser print → save as PDF) and a "Copy as Text" button.

**How do I update the shot list template for all events?** Edit `wedding-shot-list.html`. Couples' data lives in the database; the shot definitions live in the HTML. Updating the file updates the template for everyone instantly.
