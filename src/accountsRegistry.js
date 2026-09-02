const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const MIN_PASSWORD_LENGTH = 6;
const FACTIONS = ['beast', 'clock', 'damned', 'dwarf', 'dynasty', 'elf', 'fallen', 'human', 'orc', 'undead'];
const MIN_FACTION_GAMES = 5;

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
      if (url.pathname === '/api/hud-layout/save' && request.method === 'POST') return this.handleSaveHudLayout(request);
      if (url.pathname === '/api/hud-layout/load' && request.method === 'POST') return this.handleLoadHudLayout(request);
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
}
