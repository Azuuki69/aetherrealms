import { validateDeck } from './game/rules.js';

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
const LOBBY_LAYOUTS = ['classic', 'sidebar', 'compact', 'showcase', 'sidebar-hud'];
const MAX_CUSTOM_DECKS_PER_USER = 30;
const MAX_CUSTOM_DECK_NAME_LENGTH = 60;

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
      if (url.pathname === '/api/card-font/save' && request.method === 'POST') return this.handleSaveCardFontScale(request);
      if (url.pathname === '/api/card-font/load' && request.method === 'POST') return this.handleLoadCardFontScale(request);
      if (url.pathname === '/api/custom-decks/save' && request.method === 'POST') return this.handleSaveCustomDeck(request);
      if (url.pathname === '/api/custom-decks/load' && request.method === 'POST') return this.handleLoadCustomDecks(request);
      if (url.pathname === '/api/custom-decks/delete' && request.method === 'POST') return this.handleDeleteCustomDeck(request);
      if (url.pathname === '/api/account-info' && request.method === 'POST') return this.handleAccountInfo(request);
      if (url.pathname === '/api/admin/accounts' && request.method === 'POST') return this.handleAdminAccounts(request);
      if (url.pathname === '/api/admin/delete-account' && request.method === 'POST') return this.handleAdminDeleteAccount(request);
      if (url.pathname === '/api/admin/reset-players' && request.method === 'POST') return this.handleAdminResetPlayers(request);
      if (url.pathname === '/api/admin/reset-factions' && request.method === 'POST') return this.handleAdminResetFactions(request);
      if (url.pathname === '/api/admin/reset-ai-stats' && request.method === 'POST') return this.handleAdminResetAiStats(request);
      if (url.pathname === '/api/site-settings' && request.method === 'GET') return this.handleSiteSettings();
      if (url.pathname === '/api/admin/set-lobby-layout' && request.method === 'POST') return this.handleAdminSetLobbyLayout(request);
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

  async handleSaveCardFontScale(request) {
    const body = await request.json().catch(() => ({}));
    const token = (body.token || '').toString();
    const scale = body.scale;
    const username = await this.resolveUsernameFromToken(token);
    if (!username) return json({ error: 'Not logged in.' }, 401);
    if (typeof scale !== 'number' || !Number.isFinite(scale)) return json({ error: 'Missing scale.' }, 400);
    const cardFontPrefs = (await this.state.storage.get('cardFontPrefs')) || {};
    cardFontPrefs[username.toLowerCase()] = { scale };
    await this.state.storage.put('cardFontPrefs', cardFontPrefs);
    return json({ ok: true });
  }

  async handleLoadCardFontScale(request) {
    const body = await request.json().catch(() => ({}));
    const token = (body.token || '').toString();
    const username = await this.resolveUsernameFromToken(token);
    if (!username) return json({ scale: null });
    const cardFontPrefs = (await this.state.storage.get('cardFontPrefs')) || {};
    return json({ scale: cardFontPrefs[username.toLowerCase()]?.scale ?? null });
  }

  // Never trusts a client-reported deck size/quantity list — re-validates
  // with the same authoritative validateDeck() a match join re-checks
  // against, so a save can't smuggle in an illegal deck any more than a
  // join could. Creates (no id, or an id this account doesn't own) or
  // updates in place (a matching, owned id — preserving createdAt).
  async handleSaveCustomDeck(request) {
    const body = await request.json().catch(() => ({}));
    const token = (body.token || '').toString();
    const username = await this.resolveUsernameFromToken(token);
    if (!username) return json({ error: 'Not logged in.' }, 401);

    const input = body.deck && typeof body.deck === 'object' ? body.deck : {};
    const factionKey = (input.factionKey || '').toString();
    const cards = input.cards;
    const check = validateDeck(factionKey, cards);
    if (!check.valid) return json({ errors: check.errors }, 400);

    const name = (input.name || '').toString().trim().slice(0, MAX_CUSTOM_DECK_NAME_LENGTH) || `My ${factionKey} Deck`;

    const key = username.toLowerCase();
    const customDecks = (await this.state.storage.get('customDecks')) || {};
    const ownDecks = customDecks[key] || [];
    const clientId = typeof input.id === 'string' && input.id ? input.id : null;
    const existingIdx = clientId ? ownDecks.findIndex((d) => d.id === clientId) : -1;

    const now = Date.now();
    let saved;
    if (existingIdx !== -1) {
      const existing = ownDecks[existingIdx];
      saved = { ...existing, name, factionKey, cards, updatedAt: now };
      ownDecks[existingIdx] = saved;
    } else {
      if (ownDecks.length >= MAX_CUSTOM_DECKS_PER_USER) {
        return json({ error: `You can only save up to ${MAX_CUSTOM_DECKS_PER_USER} custom decks.` }, 400);
      }
      // Adopts the client-generated id (this game's decks are always
      // created client-side, id included, for a local-first save that
      // works before login too) rather than minting a new one — otherwise
      // the local cache and the account copy would end up as two
      // differently-id'd decks the moment this first save round-trips.
      saved = {
        id: clientId || `cd_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        factionKey,
        cards,
        createdAt: now,
        updatedAt: now,
      };
      ownDecks.push(saved);
    }
    customDecks[key] = ownDecks;
    await this.state.storage.put('customDecks', customDecks);
    return json({ ok: true, deck: saved });
  }

  async handleLoadCustomDecks(request) {
    const body = await request.json().catch(() => ({}));
    const token = (body.token || '').toString();
    const username = await this.resolveUsernameFromToken(token);
    if (!username) return json({ decks: [] });
    const customDecks = (await this.state.storage.get('customDecks')) || {};
    return json({ decks: customDecks[username.toLowerCase()] || [] });
  }

  async handleDeleteCustomDeck(request) {
    const body = await request.json().catch(() => ({}));
    const token = (body.token || '').toString();
    const id = (body.id || '').toString();
    const username = await this.resolveUsernameFromToken(token);
    if (!username) return json({ error: 'Not logged in.' }, 401);
    const key = username.toLowerCase();
    const customDecks = (await this.state.storage.get('customDecks')) || {};
    const ownDecks = customDecks[key] || [];
    customDecks[key] = ownDecks.filter((d) => d.id !== id);
    await this.state.storage.put('customDecks', customDecks);
    return json({ ok: true });
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
    const customDecks = (await this.state.storage.get('customDecks')) || {};
    if (customDecks[key]) {
      delete customDecks[key];
      await this.state.storage.put('customDecks', customDecks);
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

  // Public, unauthenticated — every visitor needs this before the lobby can
  // render in the admin's chosen arrangement, not just logged-in players.
  async handleSiteSettings() {
    const siteSettings = (await this.state.storage.get('siteSettings')) || {};
    return json({ lobbyLayout: siteSettings.lobbyLayout || 'classic' });
  }

  async handleAdminSetLobbyLayout(request) {
    const gate = await this.requireAdmin(request);
    if (!gate.ok) return gate.response;
    const layout = (gate.body.layout || '').toString();
    if (!LOBBY_LAYOUTS.includes(layout)) {
      return json({ error: `layout must be one of: ${LOBBY_LAYOUTS.join(', ')}` }, 400);
    }
    const siteSettings = (await this.state.storage.get('siteSettings')) || {};
    siteSettings.lobbyLayout = layout;
    await this.state.storage.put('siteSettings', siteSettings);
    return json({ ok: true });
  }
}
