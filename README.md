# VEYROX Discord Activity — Setup Guide

A Discord Activity (the iframe apps that launch inside a voice channel)
showing the server health score, raid stats, mod-action breakdown, a
health-score trend, and recent cases — pulled from the same MongoDB the
bot writes to, live. Now includes gated write actions (warn/mute/kick/ban)
and a per-user custom wallpaper picker.

---

## 1. Discord Developer Portal setup

1. Go to https://discord.com/developers/applications and open **your
   existing VEYROX application** (an Activity is a feature of an
   existing app, not a new bot).

2. Left sidebar → **OAuth2** → note your **Client ID** and generate/copy
   your **Client Secret**.

3. Left sidebar → **Activities** → **Getting Started** → enable
   Activities for this app.

4. Still under Activities → **URL Mappings** → add a mapping:
   - **Root Mapping**: `/` → `your-app-name.onrender.com` (fill in once
     you have the Render URL from step 3 below).

5. Left sidebar → **OAuth2** → **Redirects** → add:
   `https://your-app-name.onrender.com`

6. If you're wiring up the moderation buttons, under **Bot** make sure
   the bot has `Kick Members`, `Ban Members`, and `Moderate Members`
   (timeout) permissions in the servers it moderates — the Activity
   checks the *caller's* permissions, but the *bot* still needs the
   permission to actually perform the action.

---

## 2. Deploy to Render (free tier)

1. Push this whole folder to its own GitHub repo (separate from the
   bot's repo).

2. Go to https://render.com → **New** → **Web Service** → connect that
   repo.

3. Settings:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free

4. Under **Environment**, add (see `.env.example`):
   - `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`
   - `MONGO_URI` — the exact same connection string the bot uses. If the
     bot's MongoDB is only reachable from Termux/local, this won't
     reach it from Render — use a cloud Mongo (Atlas free tier) for
     both, or point both at the same Atlas cluster.
   - `MONGO_NAME` — same database name the bot uses (defaults to `reo`)
   - `BOT_TOKEN` — same bot token the VEYROX bot process uses. Only
     needed for the moderation buttons and permission checks; leave
     blank to run fully read-only (the `/api/moderate` endpoint returns
     `501` when unset, everything else still works).

5. Deploy, copy the Render URL, and set it as the Root Mapping target
   in step 4 above.

6. Open `public/app.js` and replace `YOUR_CLIENT_ID_HERE` with your
   real Client ID, then redeploy.

**Free tier heads up**: Render's free tier spins down after 15 minutes
idle and takes ~30-60s to wake up. Fine for testing; the $7/mo tier
removes the spin-down if this becomes something people use regularly.

---

## 3. Testing it

Activities only work embedded in an actual Discord voice channel —
opening the Render URL directly in a browser tab shows "Open this from
inside a Discord voice channel Activity" (expected, not a bug).

Join a voice channel where the bot is present, open the 🚀 Activities
picker, and it should be listed once the URL Mapping is set.

---

## 4. What changed since v1

- **Guild ID is now a string end-to-end.** v1 used `parseInt()` on the
  guild ID, which silently corrupts Discord snowflakes (they exceed
  `Number.MAX_SAFE_INTEGER`). If your `cases`/`invite_joins` docs store
  `guild_id` as a string (typical), this is required for the dashboard
  to return correct data at all.
- **Membership check.** `/api/dashboard/:guildId` and `/api/trend/:guildId`
  now verify the caller is actually a member of that guild via
  `GET /users/@me/guilds/:id/member`, using their OAuth token. v1 had no
  such check — any valid token could read any guild's data.
- **Retention score** now factors into the composite, using an
  `invite_joins` collection.
- **Time range toggle** (7d/30d/90d) via `?days=` on the dashboard and
  trend endpoints.
- **Action-type breakdown**, **case pagination** (`?offset=`), and a
  **health-score trend sparkline** backed by daily snapshots
  (`health_snapshots` collection, one doc/guild/day).
- **90s in-memory cache** on the dashboard endpoint.
- **`/health` pings Mongo**, not just Express.
- **Write actions**: warn/mute/kick/ban from the dashboard, gated on
  the caller's real Discord permissions (computed server-side from
  their roles via the bot token — never trusted from the client).
- **Custom wallpaper**: a picker (preset gradients or an https image
  URL) persisted per-user in an `activity_prefs` collection, so it
  follows them across sessions.

## Schema assumptions to verify against the bot's actual code

These are the fields this Activity expects — check them against the
bot's real Mongo schema before relying on this in production:

- `cases`: `guild_id` (string), `case_id` (int, per-guild sequential),
  `action`, `reason`, `user_id`, `moderator_id`, `created_at`.
- `invite_joins`: `guild_id` (string), `event` (`'join'` | `'leave'`),
  `at` (date). If the bot's field names differ, the retention score
  silently falls back to the 100 placeholder rather than erroring —
  check server logs for `invite_joins lookup skipped` to confirm
  whether it's actually reading real data.
- New collections this Activity owns: `health_snapshots`,
  `activity_prefs`. Safe to add — the bot doesn't need to know about
  either.

## What changed in this pass — permission-gated UX

- **Buttons reflect real permissions before you ever tap one.** A new
  `GET /api/permissions/:guildId` computes the caller's actual Discord
  permissions (same server-side logic `/api/moderate` already enforced)
  and the frontend uses it to disable/hide warn, mute, kick, ban
  individually. The server-side check in `/api/moderate` stays the real
  gate — this is a UX layer on top, not a replacement for it.
- **Server name/icon** in the header via `GET /api/guild/:guildId`
  (membership-checked, same as the dashboard).
- **Voice channel participant avatars**, pulled directly from the
  Embedded App SDK — no backend call needed for this one.
- **Expandable case rows** — tap a case to see the full reason,
  formatted timestamp, and moderator ID.
- **Filter cases by user ID** — debounced search box above the case
  list; scores stay computed off the full guild history, only the list
  itself narrows.
- **Toasts instead of `alert()`** for mod-action results.
- **Confirm step before kick/ban** — a second `confirm()` beyond the
  existing prompts, since those are destructive and irreversible from
  here.
- **Animated circular score ring** (SVG, CSS transition) instead of a
  plain number.

## Still not included

- No caching layer beyond the 90s in-memory TTL — fine at low traffic,
  move to Redis if this runs on more than one instance or gets busy.
- No rate limiting on the API routes.
- No custom-image upload — the wallpaper picker takes an https URL,
  not a file upload, to avoid storing large blobs in Mongo.
