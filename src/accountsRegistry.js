const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const MIN_PASSWORD_LENGTH = 6;
const FACTIONS = ['beast', 'clock', 'damned', 'dwarf', 'dynasty', 'elf', 'fallen', 'human', 'orc', 'undead'];
const MIN_FACTION_GAMES = 5;
// The whole "admin" system: a hardcoded, case-insensitive allowlist. Account
// storage here is a plain KV map with no schema/migration tooling, so this is
// both the simplest way to grant admin and exactly as secure as a stored
// isAdmin flag would be — every admin endpoint re-checks this on every
// request from the session token, never trusting anything the client sends.
const ADMIN_USERNAMES = new Set(['kochiyo']);
function isAdmin(username) {
  return !!username && ADMIN_USERNAMES.has(username.toLowerCase());
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(saltHex + password));
  return bytesToHex(new Uint8Array(digest));
}
function randomSaltHex() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

export class AccountsRegistry {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/register' && request.method === 'POST') return this.handleRegister(request);
      if (url.pathname === '/api/login' && request.method === 'POST') return this.handleLogin(request);
      if (url.pathname === '/api/rankings' && request.method === 'GET') return this.handleRankings();
      if (url.pathname === '/resolve-session' && request.method === 'POST') return this.handleResolveSession(request);
      if (url.pathname === '/record-result' && request.method === 'POST') return this.handleRecordResult(request);
      if (url.pathname === '/record-ai-result' && request.method === 'POST') return this.handleRecordAiResult(request);
      if (url.pathname === '/api/ai-stats' && request.method === 'POST') return this.handleAiStats(request);
      if (url.pathname === '/api/hud-layout/save' && request.method === 'POST') return this.handleSaveHudLayout(request);
      if (url.pathname === '/api/hud-layout/load' && request.method === 'POST') return this.handleLoadHudLayout(request);
      if (url.pathname === '/api/account-info' && request.method === 'POST') return this.handleAccountInfo(request);
      if (url.pathname === '/api/admin/accounts' && request.method === 'POST') return this.handleAdminAccounts(request);
      if (url.pathname === '/api/admin/delete-account' && request.method === 'POST') return this.handleAdminDeleteAccount(request);
      if (url.pathname === '/api/admin/reset-players' && request.method === 'POST') return this.handleAdminResetPlayers(request);
      if (url.pathname === '/api/admin/reset-factions' && request.method === 'POST') return this.handleAdminResetFactions(request);
      if (url.pathname === '/api/admin/reset-ai-stats' && request.method === 'POST') return this.handleAdminResetAiStats(request);
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }
  }

  async handleRegister(request) {
    const body = await request.json().catch(() => ({}));
    const username = (body.username || '').toString();
    const password = (body.password || '').toString();
    if (!USERNAME_RE.test(username)) {
      return json({ error: 'Username must be 3-20 characters: letters, numbers, underscore.' }, 400);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, 400);
    }
    const accounts = (await this.state.storage.get('accounts')) || {};
    const key = username.toLowerCase();
    if (accounts[key]) return json({ error: 'That username is taken.' }, 409);

    const salt = randomSaltHex();
    const hash = await hashPassword(password, salt);
    accounts[key] = { username, salt, hash };
    await this.state.storage.put('accounts', accounts);

    const token = crypto.randomUUID();
    const sessions = (await this.state.storage.get('sessions')) || {};
    sessions[token] = username;
    await this.state.storage.put('sessions', sessions);
    return json({ token, username });
  }

  async handleLogin(request) {
    const body = await request.json().catch(() => ({}));
    const username = (body.username || '').toString();
    const password = (body.password || '').toString();
    const accounts = (await this.state.storage.get('accounts')) || {};
    const account = accounts[username.toLowerCase()];
    if (!account) return json({ error: 'Invalid username or password.' }, 401);
    const hash = await hashPassword(password, account.salt);
    if (hash !== account.hash) return json({ error: 'Invalid username or password.' }, 401);

    const token = crypto.randomUUID();
    const sessions = (await this.state.storage.get('sessions')) || {};
    sessions[token] = account.username;
    await this.state.storage.put('sessions', sessions);
    return json({ token, username: account.username });
  }

  async handleResolveSession(request) {
    const body = await request.json().catch(() => ({}));
    const token = (body.token || '').toString();
    if (!token) return json({ username: null });
    const sessions = (await this.state.storage.get('sessions')) || {};
    return json({ username: sessions[token] || null });
  }

  async handleRankings() {
    const playerStats = (await this.state.storage.get('playerStats')) || {};
    const factionStats = (await this.state.storage.get('factionStats')) || {};
    const players = Object.values(playerStats)
      .map((p) => ({ username: p.username, wins: p.wins, losses: p.losses }))
      .sort((a, b) => b.wins - a.wins);

    const rows = FACTIONS.map((faction) => {
      const s = factionStats[faction] || { wins: 0, losses: 0 };
      const games = s.wins + s.losses;
      return { faction, wins: s.wins, losses: s.losses, games, winRate: games > 0 ? s.wins / games : 0 };
    });
    const ranked = rows.filter((f) => f.games >= MIN_FACTION_GAMES).sort((a, b) => b.winRate - a.winRate || b.games - a.games);
    const unranked = rows.filter((f) => f.games < MIN_FACTION_GAMES).sort((a, b) => b.games - a.games);
    return json({ players, factions: [...ranked, ...unranked], minFactionGames: MIN_FACTION_GAMES });
  }

  async resolveUsernameFromToken(token) {
    if (!token) return null;
    const sessions = (await this.state.storage.get('sessions')) || {};
    return sessions[token] || null;
  }

  async handleSaveHudLayout(request) {
    const body = await request.json().catch(() => ({}));
    const token = (body.token || '').toString();
    const layout = body.layout;
    const username = await this.resolveUsernameFromToken(token);
    if (!username) return json({ error: 'Not logged in.' }, 401);
    if (!layout || typeof layout !== 'object') return json({ error: 'Missing layout.' }, 400);
    const hudLayouts = (await this.state.storage.get('hudLayouts')) || {};
    hudLayouts[username.toLowerCase()] = layout;
    await this.state.storage.put('hudLayouts', hudLayouts);
    return json({ ok: true });
  }

  async handleLoadHudLayout(request) {
    const body = await request.json().catch(() => ({}));
    const token = (body.token || '').toString();
    const username = await this.resolveUsernameFromToken(token);
    if (!username) return json({ layout: null });
    const hudLayouts = (await this.state.storage.get('hudLayouts')) || {};
    return json({ layout: hudLayouts[username.toLowerCase()] || null });
  }

  async handleRecordResult(request) {
    const body = await request.json().catch(() => ({}));
    const { winnerUsername, winnerFaction, loserUsername, loserFaction } = body;
    if (winnerUsername || loserUsername) {
      const playerStats = (await this.state.storage.get('playerStats')) || {};
      if (winnerUsername) {
        const key = winnerUsername.toLowerCase();
        const p = playerStats[key] || { username: winnerUsername, wins: 0, losses: 0 };
        p.wins += 1;
        playerStats[key] = p;
      }
      if (loserUsername) {
        const key = loserUsername.toLowerCase();
        const p = playerStats[key] || { username: loserUsername, wins: 0, losses: 0 };
        p.losses += 1;
        playerStats[key] = p;
      }
      await this.state.storage.put('playerStats', playerStats);
    }
    if (winnerFaction || loserFaction) {
      const factionStats = (await this.state.storage.get('factionStats')) || {};
      if (winnerFaction) {
        const f = factionStats[winnerFaction] || { wins: 0, losses: 0 };
        f.wins += 1;
        factionStats[winnerFaction] = f;
      }
      if (loserFaction) {
        const f = factionStats[loserFaction] || { wins: 0, losses: 0 };
        f.losses += 1;
        factionStats[loserFaction] = f;
      }
      await this.state.storage.put('factionStats', factionStats);
    }
    return json({ ok: true });
  }

  // Entirely separate storage key and code path from handleRecordResult()
  // above — an AI match never touches `playerStats` or `factionStats` (the
  // ranked leaderboard), by construction rather than by a shared flag.
  async handleRecordAiResult(request) {
    const body = await request.json().catch(() => ({}));
    const { username, won } = body;
    if (!username) return json({ ok: true });
    const aiStats = (await this.state.storage.get('aiStats')) || {};
    const key = username.toLowerCase();
    const p = aiStats[key] || { username, wins: 0, losses: 0 };
    if (won) p.wins += 1;
    else p.losses += 1;
    aiStats[key] = p;
    await this.state.storage.put('aiStats', aiStats);
    return json({ ok: true });
  }

  async handleAiStats(request) {
    const body = await request.json().catch(() => ({}));
    const token = (body.token || '').toString();
    const username = await this.resolveUsernameFromToken(token);
    if (!username) return json({ wins: 0, losses: 0 });
    const aiStats = (await this.state.storage.get('aiStats')) || {};
    const p = aiStats[username.toLowerCase()] || { wins: 0, losses: 0 };
    return json({ wins: p.wins, losses: p.losses });
  }

  async handleAccountInfo(request) {
    const body = await request.json().catch(() => ({}));
    const token = (body.token || '').toString();
    const username = await this.resolveUsernameFromToken(token);
    return json({ username: username || null, isAdmin: isAdmin(username) });
  }

  // Every admin endpoint below calls this first. Resolves the session token
  // itself rather than trusting anything else in the request body — the only
  // thing that ever grants admin access is ADMIN_USERNAMES, checked fresh on
  // every call, so no client-visible state (including the panel simply being
  // open) has any bearing on whether an action actually succeeds.
  async requireAdmin(request) {
    const body = await request.json().catch(() => ({}));
    const token = (body.token || '').toString();
    const username = await this.resolveUsernameFromToken(token);
    if (!isAdmin(username)) return { ok: false, response: json({ error: 'Admin access required.' }, 403) };
    return { ok: true, username, body };
  }

  async handleAdminAccounts(request) {
    const gate = await this.requireAdmin(request);
    if (!gate.ok) return gate.response;
    const accounts = (await this.state.storage.get('accounts')) || {};
    return json({ accounts: Object.values(accounts).map((a) => a.username) });
  }

  async handleAdminDeleteAccount(request) {
    const gate = await this.requireAdmin(request);
    if (!gate.ok) return gate.response;
    const targetUsername = (gate.body.targetUsername || '').toString();
    const key = targetUsername.toLowerCase();
    if (!key) return json({ error: 'Missing targetUsername.' }, 400);

    const accounts = (await this.state.storage.get('accounts')) || {};
    if (!accounts[key]) return json({ error: 'No such account.' }, 404);
    delete accounts[key];
    await this.state.storage.put('accounts', accounts);

    // Any session token still pointing at this account must stop working
    // immediately, not linger until it happens to expire (there is no
    // expiry) — a deleted account shouldn't stay logged in anywhere.
    const sessions = (await this.state.storage.get('sessions')) || {};
    let sessionsChanged = false;
    for (const [tok, user] of Object.entries(sessions)) {
      if ((user || '').toLowerCase() === key) {
        delete sessions[tok];
        sessionsChanged = true;
      }
    }
    if (sessionsChanged) await this.state.storage.put('sessions', sessions);

    const playerStats = (await this.state.storage.get('playerStats')) || {};
    if (playerStats[key]) {
      delete playerStats[key];
      await this.state.storage.put('playerStats', playerStats);
    }
    const aiStats = (await this.state.storage.get('aiStats')) || {};
    if (aiStats[key]) {
      delete aiStats[key];
      await this.state.storage.put('aiStats', aiStats);
    }
    const hudLayouts = (await this.state.storage.get('hudLayouts')) || {};
    if (hudLayouts[key]) {
      delete hudLayouts[key];
      await this.state.storage.put('hudLayouts', hudLayouts);
    }
    return json({ ok: true });
  }

  async handleAdminResetPlayers(request) {
    const gate = await this.requireAdmin(request);
    if (!gate.ok) return gate.response;
    await this.state.storage.put('playerStats', {});
    return json({ ok: true });
  }

  async handleAdminResetFactions(request) {
    const gate = await this.requireAdmin(request);
    if (!gate.ok) return gate.response;
    await this.state.storage.put('factionStats', {});
    return json({ ok: true });
  }

  async handleAdminResetAiStats(request) {
    const gate = await this.requireAdmin(request);
    if (!gate.ok) return gate.response;
    await this.state.storage.put('aiStats', {});
    return json({ ok: true });
  }
}
