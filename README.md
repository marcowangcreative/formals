# Formals — Wedding Photo Shot List

Per-event tool for managing the must-have formal group photos at weddings. Family fills in first names, the photographer gets a clean numbered call-out list.

## Files
- `admin.html` — dashboard for managing events. Behind a passphrase (default `changeme` — change before deploying).
- `wedding-shot-list.html` — couple-facing tool. Loads a specific event via `?e=slug`.
- `SETUP.md` — Supabase + hosting setup walkthrough.

## Live URLs (after deploy)
- Admin: `https://YOUR-DOMAIN/admin.html`
- Shot list: `https://YOUR-DOMAIN/wedding-shot-list.html?e=COUPLE-SLUG`

## Backend
Supabase (free tier). Single `events` table — see SETUP.md for SQL.

## Deploy
Static HTML — any host works. Easiest: drag the folder onto https://app.netlify.com/drop.
