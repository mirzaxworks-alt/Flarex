// VEYROX Activity backend
//
// Jobs:
//   1. OAuth2 token exchange (/api/token) - the Embedded App SDK gets an
//      auth "code" client-side, but exchanging it for an access token
//      requires the client secret, which must never touch the browser.
//   2. A dashboard API (/api/dashboard/:guildId) that reads straight from
//      the SAME MongoDB the bot writes to - no duplicate data layer.
//   3. A trend API (/api/trend/:guildId) backed by daily health-score
//      snapshots recorded on each dashboard read.
//   4. Per-user wallpaper preferences (/api/wallpaper).
//   5. Gated write actions (/api/moderate) - warn/mute/kick/ban - only
//      once the caller's computed guild permissions clear the bar.
//
// ASSUMPTIONS flagged inline with "ASSUMPTION:" - these depend on the
// bot's actual Mongo schema, which this repo doesn't have visibility
// into. Verify field names against the bot codebase before deploying.

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN = process.env.BOT_TOKEN; // needed only for /api/moderate + permission checks

const MONGO_URI = process.env.MONGO_URI;
const MONGO_NAME = process.env.MONGO_NAME || 'reo';

let mongoClient;
let db;

async function getDb() {
    if (db) return db;
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    db = mongoClient.db(MONGO_NAME);
    return db;
}

// ---------------------------------------------------------------------
// Tiny in-memory cache - fine at low traffic, swap for Redis if this
// ever runs on more than one instance.
// ---------------------------------------------------------------------
const CACHE_TTL_MS = 90 * 1000;
const cache = new Map(); // key -> { data, expires }

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expires) {
        cache.delete(key);
        return null;
    }
    return hit.data;
}

function cacheSet(key, data) {
    cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------
// Discord permission bits (relevant subset)
// ---------------------------------------------------------------------
const PERMISSIONS = {
    ADMINISTRATOR: 0x8n,
    KICK_MEMBERS: 0x2n,
    BAN_MEMBERS: 0x4n,
    MODERATE_MEMBERS: 0x10000000000n, // timeout / "mute"
};

async function discordApi(path, opts = {}) {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
        ...opts,
        headers: {
            Authorization: `Bot ${BOT_TOKEN}`,
            'Content-Type': 'application/json',
            ...(opts.headers || {}),
        },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Discord API ${path} failed: ${res.status} ${text}`);
        err.status = res.status;
        throw err;
    }
    if (res.status === 204) return null;
    return res.json();
}

// Computes a member's effective guild-level permission bitfield by
// OR-ing their roles' permissions with @everyone's. Does not account
// for channel overwrites - not needed for guild-wide mod actions.
async function getMemberPermissions(guildId, userId) {
    const [guild, member] = await Promise.all([
        discordApi(`/guilds/${guildId}`),
        discordApi(`/guilds/${guildId}/members/${userId}`),
    ]);

    const roleMap = new Map(guild.roles.map(r => [r.id, BigInt(r.permissions)]));
    let permissions = roleMap.get(guildId) || 0n; // @everyone role id == guild id

    for (const roleId of member.roles) {
        const rolePerms = roleMap.get(roleId);
        if (rolePerms) permissions |= rolePerms;
    }

    if (guild.owner_id === userId) permissions |= PERMISSIONS.ADMINISTRATOR;

    return permissions;
}

function hasAny(permissions, ...bits) {
    if (permissions & PERMISSIONS.ADMINISTRATOR) return true;
    return bits.some(bit => (permissions & bit) === bit);
}

// Verifies the bearer token's user is actually a member of guildId -
// without this, /api/dashboard/:guildId leaks any guild's data to
// anyone holding a valid (but unrelated) access token.
async function requireGuildMember(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';
        const accessToken = authHeader.replace(/^Bearer\s+/i, '');
        if (!accessToken) return res.status(401).json({ error: 'Missing access token' });

        const membership = await fetch(
            `https://discord.com/api/v10/users/@me/guilds/${req.params.guildId}/member`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        if (!membership.ok) {
            return res.status(403).json({ error: 'Not a member of this guild' });
        }

        req.discordMember = await membership.json();
        next();
    } catch (err) {
        console.error('requireGuildMember error:', err);
        res.status(500).json({ error: 'Membership check failed' });
    }
}

// ---------------------------------------------------------------------
// OAuth2 token exchange
// ---------------------------------------------------------------------
app.post('/api/token', async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'Missing code' });

        const response = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Discord token exchange failed:', errorText);
            return res.status(502).json({ error: 'Token exchange failed' });
        }

        const { access_token } = await response.json();
        res.json({ access_token });
    } catch (err) {
        console.error('Error in /api/token:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ---------------------------------------------------------------------
// Caller permissions - the frontend calls this once on load so it can
// show/hide/disable the warn/mute/kick/ban buttons up front, instead of
// only finding out via a 403 after the user already tapped one. The
// server-side check inside /api/moderate stays authoritative either way
// - this endpoint is strictly a UX convenience, not a trust boundary.
// ---------------------------------------------------------------------
app.get('/api/permissions/:guildId', requireGuildMember, async (req, res) => {
    try {
        const guildId = req.params.guildId;
        const authHeader = req.headers.authorization || '';
        const accessToken = authHeader.replace(/^Bearer\s+/i, '');

        const meRes = await fetch('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!meRes.ok) return res.status(401).json({ error: 'Invalid access token' });
        const me = await meRes.json();

        if (!BOT_TOKEN) {
            // Read-only deployment - nobody can use the write actions.
            return res.json({ can_warn: false, can_mute: false, can_kick: false, can_ban: false, configured: false });
        }

        const permissions = await getMemberPermissions(guildId, me.id);
        res.json({
            can_warn: hasAny(permissions, PERMISSIONS.MODERATE_MEMBERS),
            can_mute: hasAny(permissions, PERMISSIONS.MODERATE_MEMBERS),
            can_kick: hasAny(permissions, PERMISSIONS.KICK_MEMBERS),
            can_ban: hasAny(permissions, PERMISSIONS.BAN_MEMBERS),
            configured: true,
        });
    } catch (err) {
        console.error('Error in /api/permissions:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ---------------------------------------------------------------------
// Guild header info (name/icon) - kept behind the same membership check
// as the dashboard so it doesn't become a way to enumerate guild names.
// ---------------------------------------------------------------------
app.get('/api/guild/:guildId', requireGuildMember, async (req, res) => {
    try {
        const guildId = req.params.guildId;
        if (!BOT_TOKEN) return res.json({ name: null, icon_url: null });

        const guild = await discordApi(`/guilds/${guildId}`);
        const iconUrl = guild.icon
            ? `https://cdn.discordapp.com/icons/${guildId}/${guild.icon}.${guild.icon.startsWith('a_') ? 'gif' : 'png'}`
            : null;

        res.json({ name: guild.name, icon_url: iconUrl });
    } catch (err) {
        console.error('Error in /api/guild:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ---------------------------------------------------------------------
// Dashboard data (read) - guildId kept as a STRING throughout; Discord
// snowflakes exceed Number.MAX_SAFE_INTEGER, so parseInt() corrupts them.
// ---------------------------------------------------------------------
app.get('/api/dashboard/:guildId', requireGuildMember, async (req, res) => {
    try {
        const guildId = req.params.guildId;
        const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const searchUserId = (req.query.user_id || '').trim();
        const limit = 15;

        const cacheKey = `dash:${guildId}:${days}:${offset}:${searchUserId}`;
        const cached = cacheGet(cacheKey);
        if (cached) return res.json(cached);

        const database = await getDb();
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        // Scores are always computed from the full guild case history -
        // a user search only narrows what's *displayed* in the list below.
        const allCases = await database.collection('cases')
            .find({ guild_id: guildId })
            .sort({ created_at: -1 })
            .limit(500)
            .toArray();

        const displayCases = searchUserId
            ? allCases.filter(c => c.user_id === searchUserId)
            : allCases;

        const recentCases = allCases.filter(c => c.created_at && new Date(c.created_at) > since);

        const punitive = new Set(['warn', 'mute', 'kick', 'ban', 'shadowmute', 'jail']);
        const lockdowns = recentCases.filter(c => c.action === 'raid_lockdown').length;
        const modActions = recentCases.filter(c => punitive.has((c.action || '').toLowerCase()));

        const raidScore = Math.max(0, 100 - lockdowns * 25);
        const modScore = Math.max(0, Math.round(100 - modActions.length * 8));

        // ASSUMPTION: an `invite_joins` collection exists with one doc per
        // join/leave event: { guild_id, user_id, event: 'join'|'leave', at }.
        // Retention here = 100 - (leaves / joins in window) * 100, floored
        // at 0. Adjust field names to match the bot's real schema.
        let retentionScore = 100;
        try {
            const joins = await database.collection('invite_joins').countDocuments({
                guild_id: guildId, event: 'join', at: { $gt: since },
            });
            const leaves = await database.collection('invite_joins').countDocuments({
                guild_id: guildId, event: 'leave', at: { $gt: since },
            });
            if (joins > 0) {
                retentionScore = Math.max(0, Math.round(100 - (leaves / joins) * 100));
            }
        } catch (e) {
            // Collection may not exist yet on older bot deployments - keep
            // the 100 placeholder rather than fail the whole dashboard.
            console.warn('invite_joins lookup skipped:', e.message);
        }

        const composite = Math.round((raidScore + modScore + retentionScore) / 3);

        const actionBreakdown = {};
        for (const c of recentCases) {
            const key = (c.action || 'unknown').toLowerCase();
            actionBreakdown[key] = (actionBreakdown[key] || 0) + 1;
        }

        const recentCaseSummaries = displayCases.slice(offset, offset + limit).map(c => ({
            case_id: c.case_id,
            action: c.action,
            reason: c.reason,
            user_id: c.user_id,
            moderator_id: c.moderator_id,
            created_at: c.created_at,
        }));

        const payload = {
            guild_id: guildId,
            days,
            composite_score: composite,
            raid_score: raidScore,
            mod_score: modScore,
            retention_score: retentionScore,
            lockdown_count: lockdowns,
            mod_action_count: modActions.length,
            action_breakdown: actionBreakdown,
            recent_cases: recentCaseSummaries,
            total_cases: displayCases.length,
            search_user_id: searchUserId || null,
            offset,
            limit,
            generated_at: new Date().toISOString(),
        };

        cacheSet(cacheKey, payload);

        // Record a daily snapshot for the trend endpoint - one doc per
        // guild per calendar day, upserted so repeated views don't spam it.
        const dayKey = new Date().toISOString().slice(0, 10);
        database.collection('health_snapshots').updateOne(
            { guild_id: guildId, day: dayKey },
            { $set: {
                guild_id: guildId, day: dayKey,
                composite_score: composite, raid_score: raidScore,
                mod_score: modScore, retention_score: retentionScore,
                recorded_at: new Date(),
            } },
            { upsert: true }
        ).catch(e => console.warn('snapshot write failed:', e.message));

        res.json(payload);
    } catch (err) {
        console.error('Error in /api/dashboard:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ---------------------------------------------------------------------
// Trend data - sparkline source
// ---------------------------------------------------------------------
app.get('/api/trend/:guildId', requireGuildMember, async (req, res) => {
    try {
        const guildId = req.params.guildId;
        const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));

        const database = await getDb();
        const snapshots = await database.collection('health_snapshots')
            .find({ guild_id: guildId })
            .sort({ day: 1 })
            .limit(days)
            .toArray();

        res.json({
            guild_id: guildId,
            points: snapshots.map(s => ({ day: s.day, composite_score: s.composite_score })),
        });
    } catch (err) {
        console.error('Error in /api/trend:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ---------------------------------------------------------------------
// Wallpaper preference - per-user, persisted so it follows them across
// sessions/devices. Custom values are validated as http(s) image URLs
// only - never trust this straight into CSS without checking the scheme.
// ---------------------------------------------------------------------
const PRESET_WALLPAPERS = new Set(['none', 'aurora', 'midnight', 'circuit', 'nebula']);

function isSafeImageUrl(value) {
    try {
        const u = new URL(value);
        return u.protocol === 'https:';
    } catch {
        return false;
    }
}

app.get('/api/wallpaper', async (req, res) => {
    try {
        const userId = req.query.user_id;
        if (!userId) return res.status(400).json({ error: 'Missing user_id' });

        const database = await getDb();
        const pref = await database.collection('activity_prefs').findOne({ user_id: userId });
        res.json({ wallpaper: pref?.wallpaper || 'none' });
    } catch (err) {
        console.error('Error in GET /api/wallpaper:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

app.post('/api/wallpaper', async (req, res) => {
    try {
        const { user_id, wallpaper } = req.body;
        if (!user_id || !wallpaper) return res.status(400).json({ error: 'Missing user_id or wallpaper' });

        const isPreset = PRESET_WALLPAPERS.has(wallpaper);
        const isCustom = !isPreset && isSafeImageUrl(wallpaper);
        if (!isPreset && !isCustom) {
            return res.status(400).json({ error: 'Wallpaper must be a preset name or an https image URL' });
        }

        const database = await getDb();
        await database.collection('activity_prefs').updateOne(
            { user_id },
            { $set: { user_id, wallpaper, updated_at: new Date() } },
            { upsert: true }
        );
        res.json({ ok: true, wallpaper });
    } catch (err) {
        console.error('Error in POST /api/wallpaper:', err);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ---------------------------------------------------------------------
// Write actions (v2) - warn / mute (timeout) / kick / ban. Gated on the
// caller's actual computed Discord permissions, checked server-side via
// the bot token - never trust a client-supplied role/permission claim.
//
// ASSUMPTION: case_id generation matches the bot's own scheme of "next
// integer per guild". Verify against the bot's case-creation code before
// relying on this in production - a mismatch here could collide IDs.
// ---------------------------------------------------------------------
app.post('/api/moderate', async (req, res) => {
    try {
        const authHeader = req.headers.authorization || '';
        const accessToken = authHeader.replace(/^Bearer\s+/i, '');
        const { guild_id, target_user_id, action, reason, moderator_id, mute_minutes } = req.body;

        if (!accessToken) return res.status(401).json({ error: 'Missing access token' });
        if (!guild_id || !target_user_id || !action || !moderator_id) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (!BOT_TOKEN) return res.status(501).json({ error: 'Write actions not configured (missing BOT_TOKEN)' });

        // Confirm the token actually belongs to moderator_id and that
        // they're a member of the guild before checking permissions.
        const meRes = await fetch('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!meRes.ok) return res.status(401).json({ error: 'Invalid access token' });
        const me = await meRes.json();
        if (me.id !== moderator_id) return res.status(403).json({ error: 'Token/user mismatch' });

        const permissions = await getMemberPermissions(guild_id, moderator_id);

        const actionRequirements = {
            warn: [PERMISSIONS.MODERATE_MEMBERS],
            mute: [PERMISSIONS.MODERATE_MEMBERS],
            kick: [PERMISSIONS.KICK_MEMBERS],
            ban: [PERMISSIONS.BAN_MEMBERS],
        };
        const required = actionRequirements[action];
        if (!required) return res.status(400).json({ error: 'Unknown action' });
        if (!hasAny(permissions, ...required)) {
            return res.status(403).json({ error: 'Insufficient permissions for this action' });
        }

        // Perform the Discord-side effect for actions that have one.
        // "warn" has no native Discord effect - it's a bot-only case log.
        if (action === 'mute') {
            const minutes = Math.min(40320, Math.max(1, mute_minutes || 60)); // Discord caps timeouts at 28 days
            const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
            await discordApi(`/guilds/${guild_id}/members/${target_user_id}`, {
                method: 'PATCH',
                body: JSON.stringify({ communication_disabled_until: until }),
            });
        } else if (action === 'kick') {
            await discordApi(`/guilds/${guild_id}/members/${target_user_id}`, { method: 'DELETE' });
        } else if (action === 'ban') {
            await discordApi(`/guilds/${guild_id}/bans/${target_user_id}`, {
                method: 'PUT',
                body: JSON.stringify({ delete_message_seconds: 0 }),
            });
        }

        // Log the case in the same collection the bot's commands write to,
        // so this Activity and the bot's own !cases / healthscore logic
        // both see it - no separate data trail. See ASSUMPTION above.
        const database = await getDb();
        const last = await database.collection('cases')
            .find({ guild_id }).sort({ case_id: -1 }).limit(1).toArray();
        const nextCaseId = (last[0]?.case_id || 0) + 1;

        await database.collection('cases').insertOne({
            guild_id,
            case_id: nextCaseId,
            action,
            reason: reason || 'No reason provided',
            user_id: target_user_id,
            moderator_id,
            source: 'activity',
            created_at: new Date(),
        });

        cache.clear(); // invalidate dashboard cache for this guild
        res.json({ ok: true, case_id: nextCaseId });
    } catch (err) {
        console.error('Error in /api/moderate:', err);
        res.status(err.status === 404 ? 404 : 500).json({ error: err.message || 'Internal error' });
    }
});

app.get('/health', async (req, res) => {
    try {
        const database = await getDb();
        await database.command({ ping: 1 });
        res.json({ ok: true, db: 'connected' });
    } catch (err) {
        res.status(503).json({ ok: false, db: 'unreachable' });
    }
});

app.listen(PORT, () => {
    console.log(`VEYROX Activity backend listening on port ${PORT}`);
});

module.exports = app;
