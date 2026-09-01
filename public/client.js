const FACTION_KEYS = ['beast', 'clock', 'damned', 'dwarf', 'dynasty', 'elf', 'fallen', 'human', 'orc', 'undead'];
const LOG_ICONS = { played: '🃏', hits: '⚔️', destroyed: '💀', started: '📜', draws: '🎴', mends: '💚', rage: '🔥', rebirth: '✨' };
const factionData = {};

async function loadFactionData() {
  await Promise.all(
    FACTION_KEYS.map(async (key) => {
      const res = await fetch(`data/${key}.json`);
      factionData[key] = await res.json();
    })
  );
}

// ---------- Lobby state ----------
let selectedFaction = null;
let ws = null;
let mySeatKey = null; // 'A' or 'B', informational only
let currentView = null;
let previousBoardIds = new Set();
let selectedHandCardId = null;
let selectedMover = null; // { lane, slot } — your own unit selected to move to the opposite row, in place of attacking
let tutorialDismissed = false;
let previousHp = { you: null, opponent: null };
let combatResolvers = [];
let autoAttackRunning = false;

const el = (id) => document.getElementById(id);

function initLobby() {
  el('factionPicker').addEventListener('click', (e) => {
    const btn = e.target.closest('.faction-card');
    if (!btn) return;
    document.querySelectorAll('.faction-card').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedFaction = btn.dataset.faction;
  });

  el('createBtn').addEventListener('click', async () => {
    if (!selectedFaction) return setStatus('Pick a faction first.');
    const res = await fetch('api/room', { method: 'POST' });
    const { code } = await res.json();
    el('createdCode').textContent = code;
    el('createdCode').classList.remove('hidden');
    setStatus('Share this code with your opponent. Waiting for them to join...');
    connect(code);
  });

  el('joinBtn').addEventListener('click', () => {
    if (!selectedFaction) return setStatus('Pick a faction first.');
    const code = el('joinCode').value.trim().toUpperCase();
    if (!code) return setStatus('Enter a room code.');
    connect(code);
  });
}

function setStatus(text) {
  el('lobbyStatus').textContent = text;
}

function connect(code) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/room/${code}/ws`);
  ws.addEventListener('message', (ev) => handleMessage(JSON.parse(ev.data)));
  ws.addEventListener('close', () => setStatus('Disconnected from server.'));
  ws.addEventListener('error', () => setStatus('Connection error.'));
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'need_faction':
      ws.send(JSON.stringify({ type: 'join', faction: selectedFaction, token: getStoredAccount().token }));
      break;
    case 'waiting_for_opponent':
      setStatus('Waiting for opponent to join...');
      break;
    case 'state':
      showGame();
      currentView = msg;
      mySeatKey = msg.you_key;
      selectedHandCardId = null;
      selectedMover = null;
      render();
      combatResolvers.splice(0).forEach((r) => r('state'));
      break;
    case 'opponent_disconnected':
      logLine('Opponent disconnected. They can rejoin with the same room code.');
      break;
    case 'opponent_reconnected':
      logLine('Opponent reconnected.');
      break;
    case 'error':
      logLine('Error: ' + msg.message);
      combatResolvers.splice(0).forEach((r) => r('error'));
      break;
    case 'chat':
      addChatMessage(msg.owner, msg.text, msg.owner === mySeatKey);
      break;
  }
}

function showGame() {
  el('lobby').classList.add('hidden');
  el('game').classList.remove('hidden');
  document.body.classList.add('in-game');
}

// ---------- Scale-to-fit ----------
// #game is a fixed-size design canvas; scale it to fit whatever window is
// actually available (like a native TCG client), instead of reflowing its
// contents and risking overflow/scroll on short or non-fullscreen windows.
const GAME_DESIGN_WIDTH = 1600;
const GAME_DESIGN_HEIGHT = 950;
const GAME_MAX_SCALE = 1.4;

function updateGameScale() {
  const scale = Math.min(
    window.innerWidth / GAME_DESIGN_WIDTH,
    window.innerHeight / GAME_DESIGN_HEIGHT,
    GAME_MAX_SCALE
  );
  el('game').style.transform = `scale(${scale})`;
}
window.addEventListener('resize', updateGameScale);

// ---------- Rendering ----------
// Every finished card image already has its border, art, name, cost, DMG,
// and HP baked in by the generation pipeline, so a "card" here is mostly just
// that image sized to its slot — no runtime cropping needed. The cost/DMG/HP
// numbers are also mirrored as small CSS badges on top, since the baked-in
// numbers are too small to read at typical board scale (a fixed-resolution
// raster image can't be sharpened by resizing its container).
function buildCardEl(instance, { context = 'board' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'card' + (context === 'hand' ? ' hand-card' : '');
  if (!instance || instance.hidden) {
    wrap.classList.add('face-down');
    return wrap;
  }

  const img = document.createElement('img');
  img.className = 'art';
  img.src = instance.image;
  img.alt = instance.name;
  wrap.appendChild(img);
  wrap.title = `${instance.name}\n${instance.text || ''}`;

  const cost = document.createElement('span');
  cost.className = 'card-badge cost-badge';
  cost.textContent = instance.cost;
  const dmg = document.createElement('span');
  dmg.className = 'card-badge dmg-badge';
  dmg.textContent = instance.displayPower ?? instance.power;
  const hp = document.createElement('span');
  hp.className = 'card-badge hp-badge';
  hp.textContent = instance.defense;
  wrap.append(cost, dmg, hp);

  if (instance.countdown !== null && instance.countdown !== undefined) {
    const cd = document.createElement('span');
    cd.className = 'card-badge countdown-badge';
    cd.textContent = `⏳${instance.countdown}`;
    wrap.appendChild(cd);
  }

  if (instance.sick) wrap.classList.add('sick');
  if (instance.attackedThisTurn) wrap.classList.add('attacked');

  wrap.addEventListener('mouseenter', () => showPreview(instance));
  wrap.addEventListener('mouseleave', hidePreview);

  return wrap;
}

function showPreview(instance) {
  if (!instance.image) return;
  el('previewImg').src = instance.image;
  el('cardPreview').classList.add('visible');
}

function hidePreview() {
  el('cardPreview').classList.remove('visible');
}

function flashHpIfDropped(panelId, hp, key) {
  const prev = previousHp[key];
  if (prev !== null && hp < prev) {
    const panel = el(panelId);
    panel.classList.remove('hp-hit');
    void panel.offsetWidth; // restart animation
    panel.classList.add('hp-hit');
  }
  previousHp[key] = hp;
}

function render() {
  if (!currentView) return;
  const { you, opponent, turn, phase, turnNumber, winner, log, you_key } = currentView;
  const myTurn = turn === you_key;

  el('youInfo').querySelector('.name').textContent = `You (${capitalize(you.faction)})`;
  el('youInfo').querySelector('.hp-fill').style.width = Math.max(0, (you.hp / you.maxHp) * 100) + '%';
  el('youInfo').querySelector('.hp-value').textContent = `${Math.max(0, you.hp)}/${you.maxHp}`;
  el('youInfo').querySelector('.mana').textContent = `${you.mana}/${you.maxMana}`;
  renderManaCrystals(el('youInfo').querySelector('.mana-crystals'), you.mana, you.maxMana);
  flashHpIfDropped('youInfo', you.hp, 'you');

  el('oppInfo').querySelector('.name').textContent = `Opponent (${capitalize(opponent.faction)})`;
  el('oppInfo').querySelector('.hp-fill').style.width = Math.max(0, (opponent.hp / opponent.maxHp) * 100) + '%';
  el('oppInfo').querySelector('.hp-value').textContent = `${Math.max(0, opponent.hp)}/${opponent.maxHp}`;
  el('oppInfo').querySelector('.mana').textContent = `${opponent.mana}/${opponent.maxMana}`;
  renderManaCrystals(el('oppInfo').querySelector('.mana-crystals'), opponent.mana, opponent.maxMana);
  flashHpIfDropped('oppInfo', opponent.hp, 'opponent');

  el('turnIndicator').textContent = winner
    ? 'Game Over'
    : `Turn ${turnNumber} — ${myTurn ? 'Your' : "Opponent's"} turn (${phase})`;

  el('youDeckCount').textContent = you.deck.length;
  el('youGraveCount').textContent = you.graveyard.length;
  el('oppDeckCount').textContent = opponent.deckCount;
  el('oppGraveCount').textContent = opponent.graveyard.length;

  const newBoardIds = collectBoardIds(you, opponent);
  renderLane('youVanguard', you.board.vanguard, 'you', 'vanguard');
  renderLane('youRearguard', you.board.rearguard, 'you', 'rearguard');
  renderLane('oppVanguard', opponent.board.vanguard, 'opp', 'vanguard');
  renderLane('oppRearguard', opponent.board.rearguard, 'opp', 'rearguard');
  previousBoardIds = newBoardIds;

  renderHand(you.hand, myTurn && phase === 'deployment');

  el('combatBtn').disabled = !(myTurn && phase === 'deployment');
  el('attackAllBtn').disabled = !(myTurn && phase === 'combat') || autoAttackRunning;
  el('endTurnBtn').disabled = !(myTurn && (phase === 'combat' || phase === 'deployment')) || autoAttackRunning;

  el('log').innerHTML = '';
  for (const line of log) {
    el('log').appendChild(buildLogLine(line));
  }
  el('log').scrollTop = el('log').scrollHeight;

  highlightSelections();
  renderTutorial(turnNumber);

  if (winner) {
    el('gameOverOverlay').classList.remove('hidden');
    el('gameOverText').textContent = winner === you_key ? 'Victory!' : 'Defeat...';
  }
}

function collectBoardIds(you, opponent) {
  const ids = new Set();
  for (const p of [you, opponent]) {
    for (const lane of ['vanguard', 'rearguard']) {
      for (const unit of p.board[lane]) {
        if (unit) ids.add(unit.instanceId);
      }
    }
  }
  return ids;
}

function renderManaCrystals(container, mana, maxMana) {
  container.innerHTML = '';
  for (let i = 0; i < maxMana; i++) {
    const gem = document.createElement('span');
    gem.className = 'crystal' + (i < mana ? ' filled' : ' spent');
    container.appendChild(gem);
  }
}

function renderLane(containerId, laneArr, side, laneName) {
  const container = el(containerId);
  container.innerHTML = '';
  laneArr.forEach((unit, slotIndex) => {
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.dataset.side = side;
    slot.dataset.lane = laneName;
    slot.dataset.slot = String(slotIndex);
    if (unit) {
      const cardEl = buildCardEl(unit, { context: 'board' });
      if (!previousBoardIds.has(unit.instanceId)) cardEl.classList.add('card-enter');
      if (unit.keywords && unit.keywords.includes('guard')) cardEl.classList.add('has-guard');
      cardEl.addEventListener('click', () => onBoardCardClick(side, laneName, slotIndex));
      slot.appendChild(cardEl);
    } else {
      slot.addEventListener('click', () => onEmptySlotClick(side, laneName, slotIndex));
    }
    container.appendChild(slot);
  });
}

function renderHand(hand, interactive) {
  const handEl = el('hand');
  handEl.innerHTML = '';
  for (const card of hand) {
    const cardEl = buildCardEl(card, { context: 'hand' });
    if (currentView.you.mana < card.cost) cardEl.classList.add('unaffordable');
    if (card.instanceId === selectedHandCardId) cardEl.classList.add('selected');
    if (interactive) {
      cardEl.addEventListener('click', () => onHandCardClick(card));
    }
    handEl.appendChild(cardEl);
  }
}

function onHandCardClick(card) {
  if (currentView.you.mana < card.cost) return;
  selectedMover = null;
  selectedHandCardId = selectedHandCardId === card.instanceId ? null : card.instanceId;
  render();
}

function onEmptySlotClick(side, lane, slotIndex) {
  if (side !== 'you') return;
  if (selectedHandCardId) {
    send({ type: 'play_card', cardInstanceId: selectedHandCardId, lane, slotIndex });
    return;
  }
  if (
    selectedMover &&
    currentView.phase === 'combat' &&
    lane !== selectedMover.lane &&
    slotIndex === selectedMover.slot
  ) {
    send({ type: 'move_unit', lane: selectedMover.lane, slotIndex: selectedMover.slot });
    selectedMover = null;
    render();
  }
}

function onBoardCardClick(side, lane, slotIndex) {
  if (side !== 'you') return; // clicking the opponent's board no longer does anything — Attack All resolves combat
  const { you, turn, phase, you_key } = currentView;
  const myTurn = turn === you_key;
  if (!myTurn || phase !== 'combat' || autoAttackRunning) return;
  const unit = you.board[lane][slotIndex];
  if (!unit || unit.sick || unit.attackedThisTurn) return;
  selectedHandCardId = null;
  selectedMover =
    selectedMover && selectedMover.lane === lane && selectedMover.slot === slotIndex
      ? null
      : { lane, slot: slotIndex };
  render();
}

// Mirrors getLegalTargetLanes() in src/game/rules.js — Guard forces an
// attacker to target it from either row; a plain Rearguard occupant without
// Guard never blocks a hit on the Commander; Volley ignores Guard entirely.
function legalTargetLanes(attacker) {
  const { you, opponent } = currentView;
  const unit = you.board[attacker.lane][attacker.slot];
  if (!unit) return [];
  if (unit.keywords.includes('siege')) return ['commander'];
  const col = attacker.slot;
  const vanguard = opponent.board.vanguard[col];
  const rearguard = opponent.board.rearguard[col];
  const hasVolley = unit.keywords.includes('volley');
  const hasPrecise = unit.keywords.includes('precise');
  if (hasVolley) {
    const opts = [];
    if (vanguard) opts.push('vanguard');
    if (rearguard) opts.push('rearguard');
    if (opts.length === 0) opts.push('commander');
    return opts;
  }
  if (vanguard) return ['vanguard'];
  if (rearguard && rearguard.keywords.includes('guard') && !hasPrecise) return ['rearguard'];
  return ['commander'];
}

function highlightSelections() {
  document.querySelectorAll('.slot').forEach((s) => s.classList.remove('can-play', 'legal-target'));

  if (selectedHandCardId) {
    document.querySelectorAll('#youVanguard .slot, #youRearguard .slot').forEach((s) => {
      if (s.children.length === 0) s.classList.add('can-play');
    });
  }

  if (selectedMover) {
    const { you } = currentView;
    const targetLane = selectedMover.lane === 'vanguard' ? 'rearguard' : 'vanguard';
    if (!you.board[targetLane][selectedMover.slot]) {
      const containerId = targetLane === 'vanguard' ? 'youVanguard' : 'youRearguard';
      const slot = document.querySelectorAll(`#${containerId} .slot`)[selectedMover.slot];
      if (slot) slot.classList.add('legal-target');
    }
  }
}

function waitForCombatEvent() {
  return new Promise((resolve) => combatResolvers.push(resolve));
}

function nextEligibleAttacker() {
  const { you } = currentView;
  for (const lane of ['vanguard', 'rearguard']) {
    const row = you.board[lane];
    for (let i = 0; i < row.length; i++) {
      const unit = row[i];
      if (unit && !unit.sick && !unit.attackedThisTurn) return { lane, slot: i };
    }
  }
  return null;
}

function pickTarget(legal) {
  if (legal.includes('vanguard')) return 'vanguard';
  if (legal.includes('rearguard')) return 'rearguard';
  return 'commander';
}

async function runAttackAll() {
  if (autoAttackRunning) return;
  autoAttackRunning = true;
  render();
  try {
    for (let guard = 0; guard < 20; guard++) {
      if (!currentView || currentView.winner || currentView.phase !== 'combat') break;
      if (!ws || ws.readyState !== WebSocket.OPEN) break;
      const attacker = nextEligibleAttacker();
      if (!attacker) break;
      const legal = legalTargetLanes(attacker);
      if (legal.length === 0) break;
      send({
        type: 'attack',
        attackerLane: attacker.lane,
        attackerSlot: attacker.slot,
        targetLane: pickTarget(legal),
      });
      const result = await waitForCombatEvent();
      if (result === 'error') break;
      await new Promise((r) => setTimeout(r, 500)); // pacing so the player can follow each hit
    }
  } finally {
    autoAttackRunning = false;
    render();
  }
}

el('combatBtn')?.addEventListener('click', () => send({ type: 'move_to_combat' }));
el('attackAllBtn')?.addEventListener('click', runAttackAll);
el('endTurnBtn')?.addEventListener('click', () => {
  selectedHandCardId = null;
  selectedMover = null;
  send({ type: 'end_turn' });
});

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function logIcon(text) {
  if (/destroyed/i.test(text)) return LOG_ICONS.destroyed;
  if (/draws?/i.test(text)) return LOG_ICONS.draws;
  if (/mends/i.test(text)) return LOG_ICONS.mends;
  if (/rage/i.test(text)) return LOG_ICONS.rage;
  if (/hand at 1 hp/i.test(text)) return LOG_ICONS.rebirth;
  if (/hits/i.test(text)) return LOG_ICONS.hits;
  if (/played/i.test(text)) return LOG_ICONS.played;
  if (/match started/i.test(text)) return LOG_ICONS.started;
  return '';
}

function buildLogLine(text) {
  const d = document.createElement('div');
  const icon = logIcon(text);
  d.textContent = icon ? `${icon} ${text}` : text;
  return d;
}

function logLine(text) {
  el('log').appendChild(buildLogLine(text));
  el('log').scrollTop = el('log').scrollHeight;
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const TUTORIAL_TIP_IDS = ['tipHand', 'tipCombat', 'tipCommander', 'tipHover'];

function renderTutorial(turnNumber) {
  const show = !tutorialDismissed && turnNumber <= 3;
  for (const id of TUTORIAL_TIP_IDS) {
    el(id).classList.toggle('hidden', !show);
  }
}

function dismissTutorial() {
  tutorialDismissed = true;
  for (const id of TUTORIAL_TIP_IDS) {
    el(id).classList.add('hidden');
  }
}

function initTutorial() {
  for (const id of TUTORIAL_TIP_IDS) {
    el(id).querySelector('.tip-close').addEventListener('click', dismissTutorial);
  }
}

// ---------- Chat ----------
// Independent of render()/#log on purpose: render() destructively rebuilds
// #log from currentView.log on every 'state' push, which would wipe any
// chat line appended there before the next game action from either player.
let chatCollapsed = true;
let unreadChat = 0;

function initChat() {
  el('chatToggle').addEventListener('click', () => {
    chatCollapsed = !chatCollapsed;
    el('chatPanel').classList.toggle('collapsed', chatCollapsed);
    if (!chatCollapsed) {
      unreadChat = 0;
      updateChatBadge();
      el('chatInput').focus();
    }
  });
  el('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = el('chatInput');
    const text = input.value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    input.value = '';
  });
}

function addChatMessage(owner, text, mine) {
  const line = document.createElement('div');
  line.className = 'chat-line' + (mine ? ' mine' : '');
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = mine ? 'You:' : 'Opponent:';
  const body = document.createElement('span');
  body.textContent = text; // textContent only — never innerHTML, text is untrusted opponent input
  line.append(who, body);
  el('chatMessages').appendChild(line);
  el('chatMessages').scrollTop = el('chatMessages').scrollHeight;
  if (chatCollapsed) {
    unreadChat++;
    updateChatBadge();
  }
}

function updateChatBadge() {
  const badge = el('chatBadge');
  badge.textContent = String(unreadChat);
  badge.classList.toggle('hidden', unreadChat === 0);
}

// ---------- Account ----------
function getStoredAccount() {
  try {
    return {
      token: localStorage.getItem('ar_token'),
      username: localStorage.getItem('ar_username'),
    };
  } catch {
    return { token: null, username: null };
  }
}

function setStoredAccount(token, username) {
  try {
    localStorage.setItem('ar_token', token);
    localStorage.setItem('ar_username', username);
  } catch {
    /* localStorage unavailable — account just won't persist across reloads */
  }
}

function clearStoredAccount() {
  try {
    localStorage.removeItem('ar_token');
    localStorage.removeItem('ar_username');
  } catch {
    /* ignore */
  }
}

let accountMode = 'login'; // 'login' | 'register'

function showLoggedIn(username) {
  el('accountLoggedOut').classList.add('hidden');
  el('accountLoggedIn').classList.remove('hidden');
  el('accountUsernameLabel').textContent = username;
}

function showLoggedOut() {
  el('accountLoggedIn').classList.add('hidden');
  el('accountLoggedOut').classList.remove('hidden');
}

function setAccountStatus(text) {
  el('accountStatus').textContent = text || '';
}

function initAccount() {
  const stored = getStoredAccount();
  if (stored.token && stored.username) {
    showLoggedIn(stored.username);
  } else {
    showLoggedOut();
  }

  el('accountToggleModeBtn').addEventListener('click', () => {
    accountMode = accountMode === 'login' ? 'register' : 'login';
    el('accountSubmitBtn').textContent = accountMode === 'login' ? 'Log In' : 'Register';
    el('accountToggleModeBtn').textContent =
      accountMode === 'login' ? 'Need an account? Register' : 'Already have an account? Log In';
    setAccountStatus('');
  });

  el('accountForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = el('accountUsername').value.trim();
    const password = el('accountPassword').value;
    if (!username || !password) return setAccountStatus('Enter a username and password.');
    setAccountStatus('');
    try {
      const res = await fetch(`api/${accountMode === 'login' ? 'login' : 'register'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) return setAccountStatus(data.error || 'Something went wrong.');
      setStoredAccount(data.token, data.username);
      showLoggedIn(data.username);
      el('accountPassword').value = '';
    } catch {
      setAccountStatus('Could not reach the server.');
    }
  });

  el('accountLogoutBtn').addEventListener('click', () => {
    clearStoredAccount();
    showLoggedOut();
  });
}

// ---------- Rankings ----------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPlayerRankings(players) {
  const body = el('playersTableBody');
  body.innerHTML = '';
  if (players.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="4">No ranked players yet — log in and win a match!</td></tr>';
    return;
  }
  players.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(p.username)}</td><td>${p.wins}</td><td>${p.losses}</td>`;
    body.appendChild(tr);
  });
}

function renderFactionRankings(factions, minFactionGames) {
  const body = el('decksTableBody');
  body.innerHTML = '';
  factions.forEach((f, i) => {
    const tr = document.createElement('tr');
    const pct = Math.round(f.winRate * 100);
    const fewGames = f.games < minFactionGames ? ' <span class="few-games">(few games)</span>' : '';
    tr.innerHTML = `<td>${i + 1}</td><td>${capitalize(f.faction)}${fewGames}</td><td>${pct}%</td><td>${f.games}</td>`;
    body.appendChild(tr);
  });
}

function initRankingTabs() {
  el('tabPlayers').addEventListener('click', () => {
    el('tabPlayers').classList.add('active');
    el('tabDecks').classList.remove('active');
    el('playersTable').classList.remove('hidden');
    el('decksTable').classList.add('hidden');
  });
  el('tabDecks').addEventListener('click', () => {
    el('tabDecks').classList.add('active');
    el('tabPlayers').classList.remove('active');
    el('decksTable').classList.remove('hidden');
    el('playersTable').classList.add('hidden');
  });
}

async function loadRankings() {
  try {
    const res = await fetch('api/rankings');
    const data = await res.json();
    renderPlayerRankings(data.players || []);
    renderFactionRankings(data.factions || [], data.minFactionGames || 5);
  } catch {
    /* rankings are a nice-to-have on the lobby screen — a failed fetch shouldn't block anything else */
  }
}

function renderFactionThumbnails() {
  for (const faction of FACTION_KEYS) {
    const btn = document.querySelector(`.faction-card[data-faction="${faction}"] .thumb`);
    if (!btn) continue;
    const img = document.createElement('img');
    img.src = `assets/cards/${faction}logo.png`;
    img.alt = faction;
    btn.appendChild(img);
  }
}

(async function init() {
  await loadFactionData();
  initLobby();
  initAccount();
  initRankingTabs();
  initTutorial();
  initChat();
  renderFactionThumbnails();
  updateGameScale();
  loadRankings();
})();
