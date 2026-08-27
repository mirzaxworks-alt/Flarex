// VEYROX Activity frontend
//
// Uses the Discord Embedded App SDK straight from a CDN (esm.sh) so this
// stays a plain static site with zero build step.
//
// IMPORTANT: every network call made from inside the Activity iframe
// MUST go through Discord's proxy path prefix `/.proxy/...`.

import { DiscordSDK } from 'https://esm.sh/@discord/embedded-app-sdk@2';

const CLIENT_ID = window.DISCORD_CLIENT_ID || 'YOUR_CLIENT_ID_HERE';
const API = '/.proxy/api';

const contentEl = document.getElementById('content');
const wallpaperEl = document.getElementById('wallpaper');
const rangeToggleEl = document.getElementById('rangeToggle');

let state = {
    accessToken: null,
    guildId: null,
    userId: null,
    days: 30,
    offset: 0,
    searchUserId: '',
    permissions: { can_warn: false, can_mute: false, can_kick: false, can_ban: false, configured: false },
};

// ---------------------------------------------------------------------
// Toasts - small non-blocking status messages instead of alert()
// ---------------------------------------------------------------------
function toast(message, kind = 'info') {
    let host = document.getElementById('toastHost');
    if (!host) {
        host = document.createElement('div');
        host.id = 'toastHost';
        document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = message;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => el.remove(), 250);
    }, 3200);
}

// ---------------------------------------------------------------------
// Theme - Discord passes a `theme` query param (dark/light) into the
// Activity iframe's URL when embedded.
// ---------------------------------------------------------------------
function applyTheme() {
    const params = new URLSearchParams(window.location.search);
    const theme = params.get('theme') === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
}

// ---------------------------------------------------------------------
// Wallpaper
// ---------------------------------------------------------------------
const PRESET_GRADIENTS = {
    none: '',
    aurora: 'linear-gradient(135deg, #43b581, #5865f2)',
    midnight: 'linear-gradient(135deg, #0f1015, #23242c)',
    circuit: 'linear-gradient(135deg, #23242c, #5865f2, #0f1015)',
    nebula: 'linear-gradient(135deg, #f04747, #5865f2, #43b581)',
};

function applyWallpaper(value) {
    if (!value || value === 'none') {
        wallpaperEl.style.backgroundImage = '';
        return;
    }
    if (PRESET_GRADIENTS[value]) {
        wallpaperEl.style.backgroundImage = PRESET_GRADIENTS[value];
        return;
    }
    // Custom URL - already validated https:// server-side on save.
    wallpaperEl.style.backgroundImage = `url("${value}")`;
}

async function loadWallpaper() {
    if (!state.userId) return;
    try {
        const res = await fetch(`${API}/wallpaper?user_id=${encodeURIComponent(state.userId)}`);
        if (!res.ok) return;
        const { wallpaper } = await res.json();
        applyWallpaper(wallpaper);
        document.querySelectorAll('.preset-swatch').forEach(el => {
            el.classList.toggle('selected', el.dataset.preset === wallpaper);
        });
    } catch (err) {
        console.error('loadWallpaper error:', err);
    }
}

async function saveWallpaper(value) {
    const errEl = document.getElementById('wallpaperError');
    errEl.textContent = '';
    try {
        const res = await fetch(`${API}/wallpaper`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: state.userId, wallpaper: value }),
        });
        const data = await res.json();
        if (!res.ok) {
            errEl.textContent = data.error || 'Could not save wallpaper.';
            return;
        }
        applyWallpaper(value);
        document.querySelectorAll('.preset-swatch').forEach(el => {
            el.classList.toggle('selected', el.dataset.preset === value);
        });
    } catch (err) {
        errEl.textContent = 'Could not save wallpaper.';
    }
}

function setupWallpaperPanel() {
    const panel = document.getElementById('wallpaperPanel');
    document.getElementById('wallpaperBtn').addEventListener('click', () => panel.classList.add('open'));
    document.getElementById('closeWallpaperPanel').addEventListener('click', () => panel.classList.remove('open'));
    document.getElementById('presetGrid').addEventListener('click', (e) => {
        const swatch = e.target.closest('.preset-swatch');
        if (swatch) saveWallpaper(swatch.dataset.preset);
    });
    document.getElementById('applyCustomWallpaper').addEventListener('click', () => {
        const url = document.getElementById('customWallpaperUrl').value.trim();
        const errEl = document.getElementById('wallpaperError');
        if (!url) return;
        if (!url.startsWith('https://')) {
            errEl.textContent = 'Custom wallpapers must be an https:// image URL.';
            return;
        }
        saveWallpaper(url);
    });
}

// ---------------------------------------------------------------------
// Caller permissions - fetched once so mod-action buttons can be shown,
// hidden, or disabled up front instead of only failing after a tap.
// The server still re-checks on every /api/moderate call regardless.
// ---------------------------------------------------------------------
async function loadPermissions() {
    try {
        const res = await fetch(`${API}/permissions/${state.guildId}`, {
            headers: { Authorization: `Bearer ${state.accessToken}` },
        });
        if (!res.ok) return;
        state.permissions = await res.json();
    } catch (err) {
        console.error('loadPermissions error:', err);
    }
}

// ---------------------------------------------------------------------
// Guild header - name/icon
// ---------------------------------------------------------------------
async function loadGuildHeader() {
    const nameEl = document.getElementById('guildName');
    const iconEl = document.getElementById('guildIcon');
    try {
        const res = await fetch(`${API}/guild/${state.guildId}`, {
            headers: { Authorization: `Bearer ${state.accessToken}` },
        });
        if (!res.ok) return;
        const { name, icon_url } = await res.json();
        if (name && nameEl) nameEl.textContent = name;
        if (icon_url && iconEl) {
            iconEl.src = icon_url;
            iconEl.style.display = 'block';
        }
    } catch (err) {
        console.error('loadGuildHeader error:', err);
    }
}

// ---------------------------------------------------------------------
// Voice channel participants - straight from the Embedded App SDK, no
// backend call needed.
// ---------------------------------------------------------------------
async function loadParticipants(discordSdk) {
    const row = document.getElementById('participantRow');
    if (!row) return;
    try {
        const { participants } = await discordSdk.commands.getInstanceConnectedParticipants();
        if (!participants || !participants.length) return;
        row.innerHTML = participants.slice(0, 8).map(p => {
            const avatar = p.avatar
                ? `https://cdn.discordapp.com/avatars/${p.id}/${p.avatar}.png`
                : `https://cdn.discordapp.com/embed/avatars/${Number(p.discriminator || 0) % 5}.png`;
            return `<img class="participant-avatar" src="${avatar}" title="${p.global_name || p.username}" alt="" />`;
        }).join('');
        if (participants.length > 8) {
            row.innerHTML += `<span class="participant-more">+${participants.length - 8}</span>`;
        }
    } catch (err) {
        console.error('loadParticipants error:', err);
    }
}

// ---------------------------------------------------------------------
// Trend sparkline (no chart library - keeps this a zero-build static site)
// ---------------------------------------------------------------------
function drawTrend(canvas, points) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    if (!points || points.length < 2) {
        ctx.fillStyle = '#9a9aa5';
        ctx.font = '11px sans-serif';
        ctx.fillText('Not enough history yet', 4, h / 2);
        return;
    }

    const values = points.map(p => p.composite_score);
    const min = Math.min(...values), max = Math.max(...values);
    const range = max - min || 1;
    const stepX = w / (points.length - 1);

    ctx.beginPath();
    points.forEach((p, i) => {
        const x = i * stepX;
        const y = h - ((p.composite_score - min) / range) * (h - 6) - 3;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#5865f2';
    ctx.lineWidth = 2;
    ctx.stroke();
}

async function loadTrend() {
    try {
        const res = await fetch(`${API}/trend/${state.guildId}?days=${state.days}`, {
            headers: { Authorization: `Bearer ${state.accessToken}` },
        });
        if (!res.ok) return;
        const { points } = await res.json();
        const canvas = document.getElementById('trendCanvas');
        if (canvas) drawTrend(canvas, points);
    } catch (err) {
        console.error('loadTrend error:', err);
    }
}

// ---------------------------------------------------------------------
// Dashboard rendering
// ---------------------------------------------------------------------
function renderError(message) {
    contentEl.innerHTML = `<div class="error">${message}</div>`;
}

function actionBreakdownRows(breakdown) {
    const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return '<div class="bar-row"><span class="bar-label">No actions</span></div>';
    const max = Math.max(...entries.map(([, count]) => count));
    return entries.map(([action, count]) => `
        <div class="bar-row">
            <span class="bar-label">${action}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${(count / max) * 100}%"></span></span>
            <span class="bar-count">${count}</span>
        </div>
    `).join('');
}

function formatTimestamp(iso) {
    if (!iso) return 'Unknown time';
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function scoreRingSvg(score) {
    const radius = 52, circumference = 2 * Math.PI * radius;
    const offset = circumference * (1 - Math.max(0, Math.min(100, score)) / 100);
    const color = score >= 75 ? 'var(--good)' : score >= 50 ? 'var(--warn)' : 'var(--bad)';
    return `
        <svg width="130" height="130" viewBox="0 0 130 130" class="ring-svg">
            <circle cx="65" cy="65" r="${radius}" class="ring-track" />
            <circle cx="65" cy="65" r="${radius}" class="ring-fill" style="stroke:${color}"
                stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}"
                data-target-offset="${offset}" />
        </svg>
        <div class="score-number" style="color:${color}">${score}</div>
    `;
}

function caseRowHtml(c, index) {
    return `
        <div class="case-row" data-index="${index}">
            <div class="case-row-summary">
                <span><span class="case-action">${c.action}</span> #${c.case_id}</span>
                <span class="case-reason">${c.reason || 'No reason'}</span>
            </div>
            <div class="case-row-detail" hidden>
                <div><strong>User:</strong> <code>${c.user_id || 'unknown'}</code></div>
                ${c.moderator_id ? `<div><strong>Moderator:</strong> <code>${c.moderator_id}</code></div>` : ''}
                <div><strong>When:</strong> ${formatTimestamp(c.created_at)}</div>
                <div><strong>Reason:</strong> ${c.reason || 'No reason provided'}</div>
            </div>
        </div>
    `;
}

function renderDashboard(data) {
    const caseRows = data.recent_cases.length
        ? data.recent_cases.map((c, i) => caseRowHtml(c, i)).join('')
        : `<div class="case-row">${data.search_user_id ? 'No cases for that user.' : 'No recent cases.'}</div>`;

    const hasPrev = data.offset > 0;
    const hasNext = data.offset + data.limit < data.total_cases;

    const perms = state.permissions;
    const modButtons = [
        ['warn', 'Warn', perms.can_warn],
        ['mute', 'Mute', perms.can_mute],
        ['kick', 'Kick', perms.can_kick],
        ['ban', 'Ban', perms.can_ban],
    ];
    const anyAllowed = modButtons.some(([, , allowed]) => allowed);
    const modButtonsHtml = modButtons.map(([action, label, allowed]) => `
        <button data-action="${action}" class="${action === 'kick' || action === 'ban' ? 'danger' : ''}"
            ${allowed ? '' : 'disabled title="You don\'t have permission for this"'}>${label}</button>
    `).join('');

    contentEl.innerHTML = `
        <div class="score-ring">
            ${scoreRingSvg(data.composite_score)}
            <div class="score-label">Server Health Score · ${data.days}d</div>
            <div class="trend"><canvas id="trendCanvas"></canvas></div>
        </div>
        <div class="grid">
            <div class="stat-card"><div class="value">${data.raid_score}</div><div class="label">Raid Score</div></div>
            <div class="stat-card"><div class="value">${data.mod_score}</div><div class="label">Mod Action Score</div></div>
            <div class="stat-card"><div class="value">${data.retention_score}</div><div class="label">Retention Score</div></div>
            <div class="stat-card"><div class="value">${data.lockdown_count}</div><div class="label">Lockdowns</div></div>
        </div>
        <div class="breakdown">
            <h2>Actions by Type</h2>
            ${actionBreakdownRows(data.action_breakdown)}
        </div>

        ${perms.configured === false ? '' : `
        <div class="mod-actions">${modButtonsHtml}</div>
        <div class="mod-hint">
            ${anyAllowed ? "Requires a target user ID — you'll be prompted." : "You don't have moderation permissions in this server."}
        </div>`}

        <div class="cases">
            <div class="cases-header">
                <h2>Recent Cases</h2>
                <input type="text" id="userSearch" placeholder="Filter by user ID…" value="${data.search_user_id || ''}" />
            </div>
            ${caseRows}
            <div class="pager">
                <button id="pagerPrev" ${hasPrev ? '' : 'disabled'}>← Newer</button>
                <button id="pagerNext" ${hasNext ? '' : 'disabled'}>Older →</button>
            </div>
        </div>
    `;

    document.getElementById('pagerPrev')?.addEventListener('click', () => {
        state.offset = Math.max(0, state.offset - data.limit);
        loadDashboard();
    });
    document.getElementById('pagerNext')?.addEventListener('click', () => {
        state.offset = state.offset + data.limit;
        loadDashboard();
    });

    document.querySelectorAll('.mod-actions button:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => runModAction(btn.dataset.action));
    });

    document.querySelectorAll('.case-row[data-index]').forEach(row => {
        row.addEventListener('click', () => {
            row.querySelector('.case-row-detail')?.toggleAttribute('hidden');
        });
    });

    let searchTimer;
    document.getElementById('userSearch')?.addEventListener('input', (e) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            state.searchUserId = e.target.value.trim();
            state.offset = 0;
            loadDashboard();
        }, 400);
    });

    // Animate the score ring in on next frame (CSS transition on stroke-dashoffset).
    requestAnimationFrame(() => {
        const ring = contentEl.querySelector('.ring-fill');
        if (ring) ring.style.strokeDashoffset = ring.dataset.targetOffset;
    });

    loadTrend();
}

async function runModAction(action) {
    const targetUserId = window.prompt(`Discord user ID to ${action}:`);
    if (!targetUserId) return;
    if ((action === 'kick' || action === 'ban') && !window.confirm(`${action.toUpperCase()} user ${targetUserId}? This can't be undone from here.`)) {
        return;
    }
    const reason = window.prompt('Reason (optional):') || '';

    try {
        const res = await fetch(`${API}/moderate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${state.accessToken}`,
            },
            body: JSON.stringify({
                guild_id: state.guildId,
                target_user_id: targetUserId,
                moderator_id: state.userId,
                action,
                reason,
            }),
        });
        const data = await res.json();
        if (!res.ok) {
            toast(data.error || 'Action failed.', 'error');
            return;
        }
        toast(`Case #${data.case_id} logged.`, 'success');
        state.offset = 0;
        loadDashboard();
    } catch (err) {
        toast('Action failed.', 'error');
    }
}

async function loadDashboard() {
    try {
        const params = new URLSearchParams({ days: state.days, offset: state.offset });
        if (state.searchUserId) params.set('user_id', state.searchUserId);

        const res = await fetch(
            `${API}/dashboard/${state.guildId}?${params.toString()}`,
            { headers: { Authorization: `Bearer ${state.accessToken}` } }
        );
        if (!res.ok) {
            renderError(res.status === 403 ? "You don't have access to this server's dashboard." : 'Failed to load dashboard data.');
            return;
        }
        renderDashboard(await res.json());
    } catch (err) {
        console.error('loadDashboard error:', err);
        renderError('Something went wrong loading the dashboard.');
    }
}

function setupRangeToggle() {
    rangeToggleEl.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        rangeToggleEl.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.days = parseInt(btn.dataset.days, 10);
        state.offset = 0;
        loadDashboard();
    });
}

// ---------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------
async function main() {
    applyTheme();

    const isEmbedded = window.self !== window.top;
    if (!isEmbedded) {
        renderError('Open this from inside a Discord voice channel Activity - it only works embedded.');
        return;
    }

    try {
        const discordSdk = new DiscordSDK(CLIENT_ID);
        await discordSdk.ready();

        const { code } = await discordSdk.commands.authorize({
            client_id: CLIENT_ID,
            response_type: 'code',
            state: '',
            prompt: 'none',
            scope: ['identify'],
        });

        const tokenResponse = await fetch('/.proxy/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
        });

        if (!tokenResponse.ok) {
            renderError('Failed to authenticate with Discord.');
            return;
        }

        const { access_token } = await tokenResponse.json();
        const authResult = await discordSdk.commands.authenticate({ access_token });

        state.accessToken = access_token;
        state.userId = authResult?.user?.id || null;
        state.guildId = discordSdk.guildId;

        if (!state.guildId) {
            renderError('No server context available.');
            return;
        }

        setupRangeToggle();
        setupWallpaperPanel();
        loadWallpaper();
        loadGuildHeader();
        loadParticipants(discordSdk);
        // Permissions must resolve before the dashboard renders so the
        // mod-action buttons show the right state on first paint.
        await loadPermissions();
        loadDashboard();
    } catch (err) {
        console.error('Activity error:', err);
        renderError('Something went wrong loading the dashboard.');
    }
}

main();
