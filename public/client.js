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
let selectedUnit = null; // { lane, slot } — your own unit selected as the acting unit for this turn: clicking a legal move destination moves it, clicking a legal enemy target/the castle attacks with it
let pendingSpell = null; // { card, hits: [] } — a hand spell awaiting a target click; hits accumulates split-damage picks
let tutorialDismissed = false;
let previousView = null; // diff source for the combat feedback effect system (computeEffects)
let combatResolvers = [];
let autoAttackRunning = false;
let coinFlipAckSent = false;
let hudLayoutInitialized = false; // true once the HUD layout manager's default geometry has been captured
let hudAccountSyncedForToken; // undefined = never checked; tracks which login (if any) the layout was last synced for

// ---------- Drag-to-target arrow ----------
let dragCandidate = null; // { lane, slot, startX, startY } — set on mousedown, before the drag threshold is crossed
let isDragging = false;
let dragOrigin = null; // { x, y } — attacker card center, captured once when dragging begins
let dragCurveOffset = 90; // px cap, recomputed per-drag from the board's actual current rendered size
let suppressNextClick = false; // a drag that starts/ends on the same element still fires a native click after mouseup
const DRAG_THRESHOLD = 8; // px of mouse movement before a mousedown becomes a drag rather than a plain click

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
    el('createdCodeText').textContent = code;
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

  el('copyCodeBtn').addEventListener('click', async () => {
    const code = el('createdCodeText').textContent;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return; // clipboard permission denied or unavailable — button just won't confirm
    }
    const btn = el('copyCodeBtn');
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 1500);
  });
}

function setStatus(text) {
  el('lobbyStatus').textContent = text;
}

function connect(code) {
  coinFlipAckSent = false;
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
      selectedUnit = null;
      pendingSpell = null;
      if (msg.phase === 'coinflip') {
        renderCoinFlip(msg);
      } else {
        el('coinFlipOverlay').classList.add('hidden');
        render();
      }
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

// ---------- HUD layout preview (no match, no timer) ----------
// Lets a player customize every panel's position/size from the lobby,
// without a real opponent or the server-driven 60s turn timer — the timer
// only ever appears when currentView.turnDeadlineAt is set by a real match's
// state broadcast, which this demo view deliberately never provides.
let hudPreviewActive = false;

function demoCardInstance(card, overrides) {
  return {
    instanceId: `demo_${card.id}`,
    cardId: card.id,
    name: card.name,
    type: card.type || 'unit',
    cost: card.cost,
    power: card.power,
    displayPower: card.power,
    basePower: card.power,
    defense: card.defense,
    maxDefense: card.defense,
    text: card.text,
    image: card.image,
    target: card.target || null,
    effect: card.effect || null,
    keywords: [],
    countdown: null,
    sick: false,
    attackedThisTurn: false,
    ...overrides,
  };
}

function buildDemoView() {
  const youCards = (factionData.human && factionData.human.cards) || [];
  const oppCards = (factionData.elf && factionData.elf.cards) || [];
  const units = (cards) => cards.filter((c) => c.type !== 'spell');
  const spells = (cards) => cards.filter((c) => c.type === 'spell');
  const youUnits = units(youCards);
  const oppUnits = units(oppCards);

  const youVanguard = [youUnits[0], null, youUnits[1], null, null].map((c) => (c ? demoCardInstance(c) : null));
  const youRearguard = [null, youUnits[2], null, null, null].map((c) => (c ? demoCardInstance(c) : null));
  const oppVanguard = [null, oppUnits[0], null, oppUnits[1], null].map((c) => (c ? demoCardInstance(c) : null));
  const oppRearguard = [null, null, oppUnits[2], null, null].map((c) => (c ? demoCardInstance(c) : null));

  const hand = [...units(youCards).slice(3, 6), ...spells(youCards).slice(0, 2)].map((c) => demoCardInstance(c));

  return {
    you: {
      faction: 'human',
      hp: 38,
      maxHp: 50,
      mana: 5,
      maxMana: 5,
      deck: new Array(32).fill(null),
      graveyard: new Array(3).fill(null),
      hand,
      board: { vanguard: youVanguard, rearguard: youRearguard },
    },
    opponent: {
      faction: 'elf',
      hp: 44,
      maxHp: 50,
      mana: 4,
      maxMana: 5,
      deckCount: 29,
      graveyard: new Array(2).fill(null),
      hand: new Array(5).fill({ hidden: true }),
      board: { vanguard: oppVanguard, rearguard: oppRearguard },
    },
    turn: 'A',
    phase: 'deployment',
    turnNumber: 3,
    winner: null,
    log: ['This is a HUD layout preview — nothing here is a real match.'],
    you_key: 'A',
    lastPlayedCard: null,
    turnDeadlineAt: null,
  };
}

function enterHudPreview() {
  hudPreviewActive = true;
  currentView = buildDemoView();
  previousView = null;
  el('lobby').classList.add('hidden');
  el('game').classList.remove('hidden');
  document.body.classList.add('in-game');
  el('hudPreviewExitBtn').classList.remove('hidden');
  render();
  if (!hudEditing) toggleHudEditing();
}

function exitHudPreview() {
  hudPreviewActive = false;
  if (hudEditing) toggleHudEditing();
  el('hudPreviewExitBtn').classList.add('hidden');
  el('game').classList.add('hidden');
  el('lobby').classList.remove('hidden');
  document.body.classList.remove('in-game');
  currentView = null;
  previousView = null;
}

// The coin flip result is decided server-side (matchRoom.js, at game
// creation) — this just displays it and, once both players have seen it,
// acks so the match can move into the deployment phase.
function renderCoinFlip(view) {
  el('coinFlipOverlay').classList.remove('hidden');
  const iAmFirst = view.turn === view.you_key;
  el('coinFlipResult').textContent = iAmFirst ? 'You go first!' : 'Opponent goes first!';
  if (!coinFlipAckSent) {
    coinFlipAckSent = true;
    setTimeout(() => send({ type: 'coinflip_ack' }), 1600);
  }
}

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

  wrap.dataset.instanceId = instance.instanceId;

  const img = document.createElement('img');
  img.className = 'art';
  img.src = instance.image;
  img.alt = instance.name;
  wrap.appendChild(img);
  wrap.title = `${instance.name}\n${instance.text || ''}`;

  const cost = document.createElement('span');
  cost.className = 'card-badge cost-badge';
  cost.textContent = instance.cost;
  wrap.append(cost);
  if (instance.type === 'spell') {
    wrap.classList.add('spell-card');
  } else {
    const dmg = document.createElement('span');
    dmg.className = 'card-badge dmg-badge';
    dmg.textContent = instance.displayPower ?? instance.power;
    const hp = document.createElement('span');
    hp.className = 'card-badge hp-badge';
    hp.textContent = instance.defense;
    wrap.append(dmg, hp);
  }

  if (instance.countdown !== null && instance.countdown !== undefined) {
    const cd = document.createElement('span');
    cd.className = 'card-badge countdown-badge';
    cd.textContent = `⏳${instance.countdown}`;
    wrap.appendChild(cd);
  }

  if (instance.sick) wrap.classList.add('sick');
  if (instance.attackedThisTurn) wrap.classList.add('attacked');

  wrap.addEventListener('mouseenter', () => showPreview(instance, wrap));
  wrap.addEventListener('mouseleave', hidePreview);

  return wrap;
}

function showPreview(instance, sourceEl) {
  if (!instance.image) return;
  el('previewImg').src = instance.image;
  const preview = el('cardPreview');
  if (sourceEl) {
    const cardCenterX = sourceEl.getBoundingClientRect().left + sourceEl.offsetWidth / 2;
    // Preview pops up on whichever side the hovered card ISN'T on, so it
    // never covers the card (or the board behind it) you're looking at.
    preview.classList.toggle('preview-right', cardCenterX < window.innerWidth / 2);
  }
  preview.classList.add('visible');
}

function hidePreview() {
  el('cardPreview').classList.remove('visible');
}

function renderCastle(headerPanelId, sidePanelId, hp, maxHp, faction) {
  const headerPanel = el(headerPanelId);
  const sidePanel = el(sidePanelId);
  const img = headerPanel.querySelector('.castle-img');
  img.src = `assets/cards/${faction}castle.png`;
  img.alt = `${faction} castle`;
  const clampedHp = Math.max(0, hp);
  sidePanel.querySelector('.castle-hp-value').textContent = `${clampedHp} / ${maxHp}`;
  const ratio = maxHp > 0 ? Math.max(0, hp / maxHp) : 0;
  sidePanel.querySelector('.castle-hp-bar-fill').style.width = `${ratio * 100}%`;
  const damaged = hp > 0 && ratio < 0.66;
  const critical = hp > 0 && ratio < 0.33;
  const destroyed = hp <= 0;
  for (const panel of [headerPanel, sidePanel]) {
    panel.classList.toggle('castle-damaged', damaged);
    panel.classList.toggle('castle-critical', critical);
    panel.classList.toggle('castle-destroyed', destroyed);
  }
}

// ---------- Combat feedback effects ----------
// Diffs the previous and current view to find every meaningful state change
// (damage, healing, buffs, deaths) and turns each into a short floating
// number/flash spawned directly off that change — never a fake UI-only
// animation. Follows the same diff-a-previous-snapshot pattern the old
// flashHpIfDropped()/previousBoardIds used, just generalized.
function computeEffects(prev, next) {
  if (!prev) return [];
  const effects = [];

  if (next.lastPlayedCard && next.lastPlayedCard.seq !== prev.lastPlayedCard?.seq) {
    effects.push({ kind: 'card-reveal', owner: next.lastPlayedCard.owner, card: next.lastPlayedCard });
  }

  for (const side of ['you', 'opponent']) {
    const prevP = prev[side];
    const nextP = next[side];
    if (!prevP || !nextP) continue;

    if (nextP.hp < prevP.hp) effects.push({ kind: 'castle-damage', side, amount: prevP.hp - nextP.hp });
    else if (nextP.hp > prevP.hp) effects.push({ kind: 'castle-heal', side, amount: nextP.hp - prevP.hp });

    const prevUnits = new Map();
    for (const lane of ['vanguard', 'rearguard']) {
      prevP.board[lane].forEach((u) => { if (u) prevUnits.set(u.instanceId, u); });
    }
    const seenIds = new Set();
    for (const lane of ['vanguard', 'rearguard']) {
      nextP.board[lane].forEach((u, slot) => {
        if (!u) return;
        seenIds.add(u.instanceId);
        const pu = prevUnits.get(u.instanceId);
        if (!pu) return; // freshly-played card — already covered by the card-enter animation
        if (u.defense < pu.defense) effects.push({ kind: 'unit-damage', side, lane, slot, amount: pu.defense - u.defense });
        else if (u.defense > pu.defense) effects.push({ kind: 'unit-heal', side, lane, slot, amount: u.defense - pu.defense });
        if (u.power > pu.power) effects.push({ kind: 'unit-buff', side, lane, slot, amount: u.power - pu.power });
        if (u.maxDefense > pu.maxDefense) effects.push({ kind: 'unit-fortify', side, lane, slot, amount: u.maxDefense - pu.maxDefense });
      });
    }
    // A unit that vanished from the board and isn't explained by a Rebirth
    // return to hand is a death. Opponent hand contents are hidden, so this
    // is a best-effort heuristic capped by graveyard growth — worst case is
    // a missed/extra cosmetic effect on that one edge case, never a game-
    // state issue.
    const graveGrowth = Math.max(0, (nextP.graveyard?.length ?? 0) - (prevP.graveyard?.length ?? 0));
    let deathsShown = 0;
    for (const [id, pu] of prevUnits) {
      if (seenIds.has(id) || deathsShown >= graveGrowth) continue;
      const loc = findPrevLoc(prevP, id);
      if (loc) effects.push({ kind: 'unit-death', side, lane: loc.lane, slot: loc.slot });
      deathsShown++;
    }
  }
  return effects;
}

function findPrevLoc(playerView, instanceId) {
  for (const lane of ['vanguard', 'rearguard']) {
    const idx = playerView.board[lane].findIndex((u) => u && u.instanceId === instanceId);
    if (idx !== -1) return { lane, slot: idx };
  }
  return null;
}

function findUnitAnchorEl(side, lane, slot) {
  const containerId = (side === 'you' ? 'you' : 'opp') + (lane === 'vanguard' ? 'Vanguard' : 'Rearguard');
  const slotEl = document.querySelectorAll(`#${containerId} .slot`)[slot];
  if (!slotEl) return null;
  return slotEl.querySelector('.card') || slotEl; // dead units leave an empty (but still positioned) slot
}

function spawnEffect(fx) {
  if (fx.kind === 'castle-damage' || fx.kind === 'castle-heal') {
    const headerPanelId = fx.side === 'you' ? 'youInfo' : 'oppInfo';
    const sidePanelId = fx.side === 'you' ? 'youPanel' : 'oppPanel';
    const wrap = document.querySelector(`#${headerPanelId} .castle-wrap`);
    if (!wrap) return;
    if (fx.kind === 'castle-damage') {
      floatNumber(wrap, `-${fx.amount}`, 'fx-damage');
      pulseClass(wrap, 'castle-hit');
      const barFill = document.querySelector(`#${sidePanelId} .castle-hp-bar-fill`);
      if (barFill) pulseClass(barFill, 'bar-hit');
    } else {
      floatNumber(wrap, `+${fx.amount}`, 'fx-heal');
    }
    return;
  }
  if (fx.kind === 'card-reveal') {
    const isYou = fx.owner === currentView.you_key;
    const overlay = el('cardRevealOverlay');
    el('cardRevealImg').src = fx.card.image;
    el('cardRevealLabel').textContent = isYou ? 'You played' : 'Opponent played';
    overlay.classList.toggle('reveal-you', isYou);
    overlay.classList.toggle('reveal-opponent', !isYou);
    pulseClass(overlay, 'reveal-active');
    return;
  }
  const anchor = findUnitAnchorEl(fx.side, fx.lane, fx.slot);
  if (!anchor) return;
  switch (fx.kind) {
    case 'unit-damage':
      floatNumber(anchor, `-${fx.amount}`, 'fx-damage');
      pulseClass(anchor, 'fx-hit');
      break;
    case 'unit-heal':
      floatNumber(anchor, `+${fx.amount}`, 'fx-heal');
      break;
    case 'unit-buff':
      floatNumber(anchor, `+${fx.amount} DMG`, 'fx-buff');
      break;
    case 'unit-fortify':
      floatNumber(anchor, `+${fx.amount} HP`, 'fx-buff');
      break;
    case 'unit-death':
      floatNumber(anchor, '💀', 'fx-damage');
      pulseClass(anchor, 'fx-death');
      break;
  }
}

function floatNumber(anchorEl, text, cssClass) {
  const node = document.createElement('div');
  node.className = `fx-float ${cssClass}`;
  node.textContent = text;
  anchorEl.appendChild(node);
  node.addEventListener('animationend', () => node.remove());
}

function pulseClass(elm, cssClass) {
  elm.classList.remove(cssClass);
  void elm.offsetWidth; // restart animation
  elm.classList.add(cssClass);
}

function render() {
  if (!currentView) return;
  const effects = computeEffects(previousView, currentView);
  const { you, opponent, turn, phase, turnNumber, winner, log, you_key } = currentView;
  const myTurn = turn === you_key;
  const oppKey = you_key === 'A' ? 'B' : 'A';

  el('youInfo').querySelector('.name').textContent = `${displayName(you, you_key)} (${capitalize(you.faction)})`;
  renderCastle('youInfo', 'youPanel', you.hp, you.maxHp, you.faction);
  el('youInfo').querySelector('.mana').textContent = `${you.mana}/${you.maxMana}`;
  renderManaCrystals(el('youInfo').querySelector('.mana-crystals'), you.mana, you.maxMana);

  el('oppInfo').querySelector('.name').textContent = `${displayName(opponent, oppKey)} (${capitalize(opponent.faction)})`;
  renderCastle('oppInfo', 'oppPanel', opponent.hp, opponent.maxHp, opponent.faction);
  el('oppInfo').querySelector('.mana').textContent = `${opponent.mana}/${opponent.maxMana}`;
  renderManaCrystals(el('oppInfo').querySelector('.mana-crystals'), opponent.mana, opponent.maxMana);

  el('turnIndicatorText').textContent = winner
    ? 'Game Over'
    : `Turn ${turnNumber} — ${myTurn ? 'Your' : "Opponent's"} turn (${phase})`;
  el('youInfo').classList.toggle('active-turn', !winner && myTurn);
  el('oppInfo').classList.toggle('active-turn', !winner && !myTurn);

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

  effects.forEach(spawnEffect);
  previousView = JSON.parse(JSON.stringify(currentView));

  // First real render is the earliest point every panel's actual content
  // (names, board slots, button labels, hand cards) exists — measuring
  // default HUD geometry any earlier (e.g. right when #game first becomes
  // visible) would capture panels that are still empty/collapsed.
  if (!hudLayoutInitialized) {
    hudLayoutInitialized = true;
    initHudLayout();
  }
  syncHudLayoutWithAccount();
}

// ---------- Turn timer ----------
// Ticks locally off currentView.turnDeadlineAt (a server wall-clock
// timestamp) rather than waiting for a broadcast every second — the
// server's Durable Object alarm is the actual source of truth for the
// forfeit itself, this is purely the visible countdown.
function tickTurnTimer() {
  const timerEl = el('turnTimer');
  if (!currentView || !currentView.turnDeadlineAt || currentView.winner || currentView.phase === 'coinflip') {
    timerEl.classList.add('hidden');
    return;
  }
  const remainingMs = currentView.turnDeadlineAt - Date.now();
  const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
  timerEl.textContent = `⏱ ${remainingSec}s`;
  timerEl.classList.remove('hidden');
  timerEl.classList.toggle('timer-critical', remainingSec <= 10);
}

function initTurnTimer() {
  setInterval(tickTurnTimer, 500);
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
      if (unit.keywords && unit.keywords.includes('taunt')) cardEl.classList.add('has-taunt');
      cardEl.addEventListener('click', () => onBoardCardClick(side, laneName, slotIndex));
      cardEl.addEventListener('mousedown', (e) => onCardMouseDown(e, side, laneName, slotIndex));
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
  selectedUnit = null;
  if (card.type === 'spell') {
    if (!card.target || card.target === 'none') {
      selectedHandCardId = null;
      pendingSpell = null;
      send({ type: 'play_card', cardInstanceId: card.instanceId });
      render();
      return;
    }
    // Needs a target: arm it and wait for a click on a legal target instead
    // of casting immediately. Clicking the same spell again cancels it.
    if (pendingSpell && pendingSpell.card.instanceId === card.instanceId) {
      pendingSpell = null;
      selectedHandCardId = null;
    } else {
      pendingSpell = { card, hits: [] };
      selectedHandCardId = card.instanceId;
    }
    render();
    return;
  }
  selectedHandCardId = selectedHandCardId === card.instanceId ? null : card.instanceId;
  render();
}

// Resolves a click on a board slot while a targeted spell is armed. Returns
// true if the click was consumed as a spell target (so callers know not to
// also treat it as an attack/move/placement click).
function handleSpellTargetClick(side, lane, slotIndex) {
  const { card } = pendingSpell;
  const kind = card.target;
  const you = currentView.you;
  const opp = currentView.opponent;

  if (kind === 'ally_unit' && side === 'you' && you.board[lane][slotIndex]) {
    sendSpellTarget({ lane, slot: slotIndex });
    return true;
  }
  if (kind === 'enemy_unit' && side === 'opp' && opp.board[lane][slotIndex]) {
    sendSpellTarget({ lane, slot: slotIndex });
    return true;
  }
  if (kind === 'ally_row' && side === 'you') {
    sendSpellTarget({ lane });
    return true;
  }
  if (kind === 'multi_enemy_unit' && side === 'opp' && opp.board[lane][slotIndex]) {
    const eff = card.effect;
    const distinctSoFar = new Set(pendingSpell.hits.map((h) => `${h.lane}:${h.slot}`));
    const isNewTarget = !distinctSoFar.has(`${lane}:${slotIndex}`);
    if (isNewTarget && distinctSoFar.size >= eff.maxTargets) return true; // already used up all allowed targets
    pendingSpell.hits.push({ lane, slot: slotIndex });
    if (pendingSpell.hits.length >= eff.total) {
      sendSpellTarget({ hits: pendingSpell.hits });
    } else {
      logLine(`${card.name}: ${eff.total - pendingSpell.hits.length} more damage left to assign — click another target.`);
      render();
    }
    return true;
  }
  if (kind === 'multi_enemy_unit_distinct' && side === 'opp' && opp.board[lane][slotIndex]) {
    const eff = card.effect;
    const already = pendingSpell.hits.some((h) => h.lane === lane && h.slot === slotIndex);
    if (already) return true; // must pick different units, this one's already chosen
    pendingSpell.hits.push({ lane, slot: slotIndex });
    if (pendingSpell.hits.length >= eff.count) {
      sendSpellTarget({ hits: pendingSpell.hits });
    } else {
      logLine(`${card.name}: choose ${eff.count - pendingSpell.hits.length} more different target(s).`);
      render();
    }
    return true;
  }
  return false;
}

function sendSpellTarget(target) {
  send({ type: 'play_card', cardInstanceId: pendingSpell.card.instanceId, spellTarget: target });
  selectedHandCardId = null;
  pendingSpell = null;
  render();
}

// Every empty slot a currently-selected mover could legally step into:
// opposite row same column (front/back), or one slot left/right in the same
// row (lateral) — driven by row.length, never a hardcoded column count.
function legalMoveDestinations(mover) {
  const { you } = currentView;
  const { lane, slot } = mover;
  const row = you.board[lane];
  const oppositeLane = lane === 'vanguard' ? 'rearguard' : 'vanguard';
  const destinations = [];
  if (!you.board[oppositeLane][slot]) destinations.push({ lane: oppositeLane, slot });
  if (slot > 0 && !row[slot - 1]) destinations.push({ lane, slot: slot - 1 });
  if (slot < row.length - 1 && !row[slot + 1]) destinations.push({ lane, slot: slot + 1 });
  return destinations;
}

function onEmptySlotClick(side, lane, slotIndex) {
  if (suppressNextClick) { suppressNextClick = false; return; }
  if (pendingSpell) { handleSpellTargetClick(side, lane, slotIndex); return; }
  if (side !== 'you') return;
  if (selectedHandCardId) {
    send({ type: 'play_card', cardInstanceId: selectedHandCardId, lane, slotIndex });
    return;
  }
  if (selectedUnit && currentView.phase === 'combat') {
    const isLegal = legalMoveDestinations(selectedUnit).some(
      (d) => d.lane === lane && d.slot === slotIndex
    );
    if (isLegal) {
      send({
        type: 'move_unit',
        fromLane: selectedUnit.lane,
        fromSlot: selectedUnit.slot,
        toLane: lane,
        toSlot: slotIndex,
      });
      selectedUnit = null;
      render();
    }
  }
}

function onBoardCardClick(side, lane, slotIndex) {
  if (suppressNextClick) { suppressNextClick = false; return; }
  if (pendingSpell) { handleSpellTargetClick(side, lane, slotIndex); return; }
  const { turn, phase, you_key } = currentView;
  const myTurn = turn === you_key;
  if (!myTurn || phase !== 'combat' || autoAttackRunning) return;

  if (side === 'you') {
    const unit = currentView.you.board[lane][slotIndex];
    if (!unit || unit.sick || unit.attackedThisTurn) return;
    selectedHandCardId = null;
    selectedUnit =
      selectedUnit && selectedUnit.lane === lane && selectedUnit.slot === slotIndex
        ? null
        : { lane, slot: slotIndex };
    render();
    return;
  }

  // Clicking an enemy unit attacks it, but only if it's an actually legal
  // target for the currently-selected attacker.
  if (!selectedUnit) return;
  const isLegal = legalAttackTargets(selectedUnit).some(
    (t) => t.type === 'unit' && t.lane === lane && t.slot === slotIndex
  );
  if (!isLegal) return;
  send({
    type: 'attack',
    attackerLane: selectedUnit.lane,
    attackerSlot: selectedUnit.slot,
    targetLane: lane,
    targetSlot: slotIndex,
  });
  selectedUnit = null;
}

function onCastleClick() {
  const { turn, phase, you_key } = currentView;
  if (turn !== you_key || phase !== 'combat' || autoAttackRunning || !selectedUnit) return;
  const isLegal = legalAttackTargets(selectedUnit).some((t) => t.type === 'castle');
  if (!isLegal) return;
  send({
    type: 'attack',
    attackerLane: selectedUnit.lane,
    attackerSlot: selectedUnit.slot,
    targetLane: 'commander',
  });
  selectedUnit = null;
}

// ---------- Drag-to-target arrow ----------
// A thin input layer in front of the existing click-based resolution
// (onBoardCardClick/onEmptySlotClick/onCastleClick) — dragging never
// duplicates targeting logic, it just decides WHICH of those to call based
// on where the mouse is released. A plain click (no movement past the
// threshold) falls through untouched to the native click listeners.
const ARROW_CURVE_STRENGTH = 0.18;
const EPSILON = 0.5;

function onCardMouseDown(e, side, lane, slotIndex) {
  if (side !== 'you') return;
  const { turn, phase, you_key } = currentView || {};
  if (turn !== you_key || phase !== 'combat' || autoAttackRunning) return;
  const unit = currentView.you.board[lane][slotIndex];
  if (!unit || unit.sick || unit.attackedThisTurn) return;
  dragCandidate = { lane, slot: slotIndex, startX: e.clientX, startY: e.clientY };
}

function cardCenter(side, lane, slotIndex) {
  const containerId = (side === 'you' ? 'you' : 'opp') + (lane === 'vanguard' ? 'Vanguard' : 'Rearguard');
  const slotEl = document.querySelectorAll(`#${containerId} .slot`)[slotIndex];
  const cardEl = slotEl?.querySelector('.card');
  const rect = (cardEl || slotEl)?.getBoundingClientRect();
  if (!rect) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function beginDrag(clientX, clientY) {
  isDragging = true;
  selectedHandCardId = null;
  selectedUnit = { lane: dragCandidate.lane, slot: dragCandidate.slot };
  render(); // shows the existing legal-target highlights, reused as-is
  dragOrigin = cardCenter('you', dragCandidate.lane, dragCandidate.slot) || { x: dragCandidate.startX, y: dragCandidate.startY };
  const boardRect = document.querySelector('.board-area')?.getBoundingClientRect();
  dragCurveOffset = boardRect ? Math.max(40, Math.min(boardRect.height * 0.35, 140)) : 90;
  el('targetArrow').classList.remove('hidden');
  updateArrowTo(clientX, clientY);
}

function bezierPoint(t, p0, p1, p2) {
  const mt = 1 - t;
  return { x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x, y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y };
}

function computeControlPoint(p0, p2) {
  const dx = p2.x - p0.x;
  const dy = p2.y - p0.y;
  const distance = Math.hypot(dx, dy);
  const mid = { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 };
  if (distance < EPSILON) return mid;
  const dir = { x: dx / distance, y: dy / distance };
  const perp = { x: -dir.y, y: dir.x };
  const curveOffset = Math.min(distance * ARROW_CURVE_STRENGTH, dragCurveOffset);
  return { x: mid.x + perp.x * curveOffset, y: mid.y + perp.y * curveOffset };
}

function isPointOverLegalDrop(clientX, clientY) {
  const dropEl = document.elementFromPoint(clientX, clientY);
  if (!dropEl) return false;
  const slotEl = dropEl.closest('.slot');
  if (slotEl) {
    const { side, lane, slot } = slotEl.dataset;
    const slotIndex = Number(slot);
    if (side === 'you') return legalMoveDestinations(selectedUnit).some((d) => d.lane === lane && d.slot === slotIndex);
    return legalAttackTargets(selectedUnit).some((t) => t.type === 'unit' && t.lane === lane && t.slot === slotIndex);
  }
  if (dropEl.closest('#oppInfo')) return legalAttackTargets(selectedUnit).some((t) => t.type === 'castle');
  return false;
}

function updateArrowTo(clientX, clientY) {
  if (!dragOrigin) return;
  const p2 = { x: clientX, y: clientY };
  const p1 = computeControlPoint(dragOrigin, p2);
  el('arrowPath').setAttribute('d', `M ${dragOrigin.x},${dragOrigin.y} Q ${p1.x},${p1.y} ${p2.x},${p2.y}`);
  const beforeEnd = bezierPoint(0.95, dragOrigin, p1, p2);
  const angleDeg = (Math.atan2(p2.y - beforeEnd.y, p2.x - beforeEnd.x) * 180) / Math.PI;
  el('arrowHead').setAttribute('transform', `translate(${p2.x},${p2.y}) rotate(${angleDeg})`);
  el('targetArrow').classList.toggle('arrow-illegal', !isPointOverLegalDrop(clientX, clientY));
}

function endDrag(clientX, clientY) {
  el('targetArrow').classList.add('hidden');
  const dropEl = document.elementFromPoint(clientX, clientY);
  const mover = selectedUnit;
  isDragging = false;
  dragOrigin = null;
  if (dropEl && mover) {
    const slotEl = dropEl.closest('.slot');
    if (slotEl) {
      const { side, lane, slot } = slotEl.dataset;
      const slotIndex = Number(slot);
      if (side === 'you') onEmptySlotClick(side, lane, slotIndex);
      else onBoardCardClick(side, lane, slotIndex);
    } else if (dropEl.closest('#oppInfo')) {
      onCastleClick();
    }
  }
  // The resolution call above already acted on the drop (or safely no-op'd
  // on an illegal one); a native click still fires right after mouseup when
  // the drag started and ended on the same element (browsers dispatch it
  // synchronously in that same gesture), so swallow exactly that one
  // follow-up click. Most drops land on a DIFFERENT element than mousedown,
  // where no click ever follows at all — self-clearing on a timeout (rather
  // than only ever being reset by a click that may never come) means this
  // flag can never leak into swallowing the player's next, unrelated click.
  suppressNextClick = true;
  setTimeout(() => { suppressNextClick = false; }, 0);
  selectedUnit = null;
  render();
}

document.addEventListener('mousemove', (e) => {
  if (isDragging) {
    updateArrowTo(e.clientX, e.clientY);
    return;
  }
  if (!dragCandidate) return;
  const dist = Math.hypot(e.clientX - dragCandidate.startX, e.clientY - dragCandidate.startY);
  if (dist > DRAG_THRESHOLD) beginDrag(e.clientX, e.clientY);
});

document.addEventListener('mouseup', (e) => {
  if (isDragging) endDrag(e.clientX, e.clientY);
  dragCandidate = null;
});

// Mirrors getLegalAttackTargets() in src/game/rules.js — the single source
// of truth for "can this attacker legally hit this target" lives server-
// side; this mirror only drives which targets get highlighted/clickable.
// Returns { type: 'unit', lane, slot } or { type: 'castle' } entries.
function legalAttackTargets(attacker) {
  const { you, opponent } = currentView;
  const unit = you.board[attacker.lane][attacker.slot];
  if (!unit) return [];
  const oppBoard = opponent.board;
  const isRanged = unit.keywords.includes('volley');
  const hasPrecise = unit.keywords.includes('precise');

  if (!hasPrecise) {
    const taunts = [];
    for (const lane of ['vanguard', 'rearguard']) {
      oppBoard[lane].forEach((u, slot) => {
        if (!u || !u.keywords.includes('taunt')) return;
        const reachable = lane === 'vanguard' || isRanged || !oppBoard.vanguard[slot];
        if (reachable) taunts.push({ type: 'unit', lane, slot });
      });
    }
    if (taunts.length > 0) return taunts;
  }

  const targets = [];
  let castleReachable = false;
  for (let col = 0; col < oppBoard.vanguard.length; col++) {
    if (oppBoard.vanguard[col]) targets.push({ type: 'unit', lane: 'vanguard', slot: col });
    if (oppBoard.rearguard[col] && (isRanged || !oppBoard.vanguard[col])) {
      targets.push({ type: 'unit', lane: 'rearguard', slot: col });
    }
    if (!oppBoard.vanguard[col]) castleReachable = true;
  }
  if (castleReachable) targets.push({ type: 'castle' });
  return targets;
}

function highlightSelections() {
  document.querySelectorAll('.slot').forEach((s) => s.classList.remove('can-play', 'legal-target', 'spell-target'));
  document.querySelectorAll('.card.attack-ready').forEach((c) => c.classList.remove('attack-ready'));
  el('oppInfo').classList.remove('legal-target');

  // A quiet glow on every unit of yours that could currently act, so
  // "which of my units can attack" reads at a glance instead of requiring
  // a click-by-click check of sick/attacked state.
  const { phase, turn, you_key } = currentView;
  if (phase === 'combat' && turn === you_key) {
    for (const lane of ['vanguard', 'rearguard']) {
      document.querySelectorAll(`#you${capitalize(lane)} .slot`).forEach((slotEl) => {
        const unit = currentView.you.board[lane][Number(slotEl.dataset.slot)];
        const cardEl = slotEl.querySelector('.card');
        if (cardEl && unit && !unit.sick && !unit.attackedThisTurn) cardEl.classList.add('attack-ready');
      });
    }
  }

  if (selectedHandCardId && !pendingSpell) {
    document.querySelectorAll('#youVanguard .slot, #youRearguard .slot').forEach((s) => {
      if (s.children.length === 0) s.classList.add('can-play');
    });
  }

  if (selectedUnit) {
    legalMoveDestinations(selectedUnit).forEach(({ lane, slot }) => {
      const containerId = lane === 'vanguard' ? 'youVanguard' : 'youRearguard';
      const slotEl = document.querySelectorAll(`#${containerId} .slot`)[slot];
      if (slotEl) slotEl.classList.add('legal-target');
    });
    legalAttackTargets(selectedUnit).forEach((t) => {
      if (t.type === 'castle') {
        el('oppInfo').classList.add('legal-target');
        return;
      }
      const containerId = t.lane === 'vanguard' ? 'oppVanguard' : 'oppRearguard';
      const slotEl = document.querySelectorAll(`#${containerId} .slot`)[t.slot];
      if (slotEl) slotEl.classList.add('legal-target');
    });
  }

  if (pendingSpell) {
    const kind = pendingSpell.card.target;
    if (kind === 'ally_unit') {
      const maxTargetPower = pendingSpell.card.effect?.maxTargetPower;
      for (const laneName of ['vanguard', 'rearguard']) {
        const containerId = laneName === 'vanguard' ? 'youVanguard' : 'youRearguard';
        document.querySelectorAll(`#${containerId} .slot`).forEach((s, idx) => {
          const u = currentView.you.board[laneName][idx];
          if (u && (maxTargetPower === undefined || u.power <= maxTargetPower)) s.classList.add('spell-target');
        });
      }
    } else if (kind === 'enemy_unit' || kind === 'multi_enemy_unit' || kind === 'multi_enemy_unit_distinct') {
      const maxTargetPower = pendingSpell.card.effect?.maxTargetPower;
      for (const laneName of ['vanguard', 'rearguard']) {
        const containerId = laneName === 'vanguard' ? 'oppVanguard' : 'oppRearguard';
        document.querySelectorAll(`#${containerId} .slot`).forEach((s, idx) => {
          const u = currentView.opponent.board[laneName][idx];
          if (u && (maxTargetPower === undefined || u.power <= maxTargetPower)) s.classList.add('spell-target');
        });
      }
    } else if (kind === 'ally_row') {
      document.querySelectorAll('#youVanguard .slot, #youRearguard .slot').forEach((s) => {
        s.classList.add('spell-target');
      });
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

// Convenience auto-target for Attack All: Vanguard preferred over Rearguard
// over the castle, and among several same-tier choices, the lowest-current-
// HP enemy unit (finish off the weakest first). Taunt already narrows the
// legal list to just the mandatory target(s) before this ever runs.
function pickTarget(legal) {
  const { opponent } = currentView;
  const unitDefense = (t) => opponent.board[t.lane][t.slot].defense;
  const vanguardTargets = legal.filter((t) => t.type === 'unit' && t.lane === 'vanguard');
  const rearguardTargets = legal.filter((t) => t.type === 'unit' && t.lane === 'rearguard');
  const pool = vanguardTargets.length ? vanguardTargets : rearguardTargets;
  if (pool.length) return pool.slice().sort((a, b) => unitDefense(a) - unitDefense(b))[0];
  return legal.find((t) => t.type === 'castle') || null;
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
      const legal = legalAttackTargets(attacker);
      if (legal.length === 0) break;
      const target = pickTarget(legal);
      if (!target) break;
      send({
        type: 'attack',
        attackerLane: attacker.lane,
        attackerSlot: attacker.slot,
        targetLane: target.type === 'castle' ? 'commander' : target.lane,
        targetSlot: target.type === 'castle' ? undefined : target.slot,
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

el('customizeHudBtn')?.addEventListener('click', enterHudPreview);
el('hudPreviewExitBtn')?.addEventListener('click', exitHudPreview);
el('oppInfo')?.addEventListener('click', onCastleClick);
el('combatBtn')?.addEventListener('click', () => send({ type: 'move_to_combat' }));
el('attackAllBtn')?.addEventListener('click', runAttackAll);
el('endTurnBtn')?.addEventListener('click', () => {
  selectedHandCardId = null;
  selectedUnit = null;
  pendingSpell = null;
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

// Guests never set a username at login, so every place a player's name is
// shown falls back to their seat key rather than a generic "You"/"Opponent".
function displayName(player, key) {
  return player?.username || `Player ${key}`;
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

// ---------- Log panel ----------
let logCollapsed = true;

function initLog() {
  el('logToggle').addEventListener('click', () => {
    logCollapsed = !logCollapsed;
    el('logPanel').classList.toggle('collapsed', logCollapsed);
  });
}

// ---------- HUD layout manager ----------
// Every major battle panel is freely movable/resizable while "Edit HUD
// Layout" mode is on, persisted per-browser. Supersedes the old single-axis
// hand-column resize (#hand is now just one of these 11 panels).
const HUD_LAYOUT_STORAGE_KEY = 'aetherrealms_hud_layout';
const HUD_LAYOUT_VERSION = 1;

const HUD_PANELS = [
  { id: 'oppInfo', label: 'Enemy Info', minW: 150, minH: 50 },
  { id: 'turnIndicator', label: 'Turn Timer', minW: 120, minH: 40 },
  { id: 'youInfo', label: 'Your Info', minW: 150, minH: 50 },
  { id: 'oppPanel', label: 'Enemy Stats', minW: 70, minH: 140 },
  { id: 'boardArea', label: 'Battlefield', minW: 320, minH: 220 },
  { id: 'youPanel', label: 'Your Stats', minW: 70, minH: 140 },
  { id: 'controls', label: 'Controls', minW: 280, minH: 50 },
  { id: 'hand', label: 'Your Hand', minW: 160, minH: 120 },
  { id: 'tutorialTips', label: 'Tutorial Tips', minW: 150, minH: 60 },
  { id: 'logPanel', label: 'Battle Log', minW: 220, minH: 40, noHeight: true },
  { id: 'chatPanel', label: 'Chat', minW: 220, minH: 40, noHeight: true },
];

let hudEditing = false;
let hudDefaultLayout = null; // captured once per page load; Reset replays this, never re-measures
let hudCurrentLayout = null; // live resolved geometry (defaults merged with saved overrides)
let hudDragState = null;
let hudResizeState = null;

function loadHudLayoutStorage() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HUD_LAYOUT_STORAGE_KEY));
    return parsed && parsed.v === HUD_LAYOUT_VERSION ? parsed.panels : null;
  } catch {
    return null;
  }
}

function saveHudLayoutStorage(panels) {
  try {
    localStorage.setItem(HUD_LAYOUT_STORAGE_KEY, JSON.stringify({ v: HUD_LAYOUT_VERSION, panels }));
  } catch {
    /* localStorage unavailable — layout just won't persist */
  }
}

function measurePanelPct(panelEl, gameRect, panel) {
  const r = panelEl.getBoundingClientRect();
  // Some panels sit in CSS Grid auto-rows/columns that can collapse toward 0
  // when a sibling spanning the same track fully absorbs the grid's 1fr
  // track (a pre-existing quirk of the old layout, invisible before since
  // overflow:visible let content spill past its own collapsed cell) — floor
  // the captured default at the content's own natural size and the panel's
  // configured minimum so a freshly-converted panel is never smaller than
  // what was actually on screen.
  const width = Math.max(r.width, panelEl.scrollWidth, panel.minW);
  const height = Math.max(r.height, panelEl.scrollHeight, panel.minH);
  return {
    leftPct: ((r.left - gameRect.left) / gameRect.width) * 100,
    topPct: ((r.top - gameRect.top) / gameRect.height) * 100,
    widthPct: (width / gameRect.width) * 100,
    heightPct: (height / gameRect.height) * 100,
  };
}

function applyPanelGeometry(panel) {
  const panelEl = el(panel.id);
  const geom = hudCurrentLayout[panel.id];
  if (!panelEl || !geom) return;
  panelEl.style.position = 'absolute';
  // A grid item that becomes position:absolute keeps its assigned grid area
  // as its containing block for percentage resolution (per spec) unless
  // fully detached from grid placement — without this, width/height percentages
  // resolve against the old (possibly collapsed) grid cell instead of #game.
  panelEl.style.gridArea = 'auto';
  panelEl.style.left = `${geom.leftPct}%`;
  panelEl.style.top = `${geom.topPct}%`;
  panelEl.style.width = `${geom.widthPct}%`;
  if (!panel.noHeight) {
    panelEl.style.height = `${geom.heightPct}%`;
  } else if (geom.bodyMaxHeightPx) {
    const body = panelEl.querySelector(panel.id === 'logPanel' ? '.log-body' : '.chat-body');
    if (body) body.style.maxHeight = `${geom.bodyMaxHeightPx}px`;
  }
  syncHudOverlay(panel.id);
}

function syncHudOverlay(id) {
  const panelEl = el(id);
  const overlay = document.getElementById(`hudOverlay_${id}`);
  const game = el('game');
  if (!panelEl || !overlay || !game) return;
  const gameRect = game.getBoundingClientRect();
  const r = panelEl.getBoundingClientRect();
  overlay.style.left = `${r.left - gameRect.left}px`;
  overlay.style.top = `${r.top - gameRect.top}px`;
  overlay.style.width = `${r.width}px`;
  overlay.style.height = `${r.height}px`;
}

function injectHudHandles(panel) {
  const layer = el('hudOverlayLayer');
  if (!layer) return;
  const overlay = document.createElement('div');
  overlay.className = 'hud-panel-overlay';
  overlay.id = `hudOverlay_${panel.id}`;
  overlay.innerHTML = `<div class="hud-drag-handle">${panel.label}</div><div class="hud-resize-grip"></div>`;
  layer.appendChild(overlay);
  overlay.querySelector('.hud-drag-handle').addEventListener('mousedown', (e) => startHudDrag(e, panel.id));
  overlay.querySelector('.hud-resize-grip').addEventListener('mousedown', (e) => startHudResize(e, panel.id));
}

function startHudDrag(e, id) {
  if (!hudEditing) return;
  e.preventDefault();
  const g = hudCurrentLayout[id];
  hudDragState = { id, startX: e.clientX, startY: e.clientY, startLeftPct: g.leftPct, startTopPct: g.topPct };
  el(id).classList.add('hud-dragging');
}

function startHudResize(e, id) {
  if (!hudEditing) return;
  e.preventDefault();
  e.stopPropagation();
  const g = hudCurrentLayout[id];
  hudResizeState = { id, startX: e.clientX, startY: e.clientY, startWidthPct: g.widthPct, startHeightPct: g.heightPct };
  el(id).classList.add('hud-resizing');
}

function clampPct(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

document.addEventListener('mousemove', (e) => {
  if (!hudDragState && !hudResizeState) return;
  const game = el('game');
  if (!game) return;
  const gameRect = game.getBoundingClientRect(); // read fresh, like the old hand-resize did

  if (hudDragState) {
    const { id, startX, startY, startLeftPct, startTopPct } = hudDragState;
    const r = el(id).getBoundingClientRect();
    const widthPct = (r.width / gameRect.width) * 100;
    const heightPct = (r.height / gameRect.height) * 100;
    const g = hudCurrentLayout[id];
    g.leftPct = clampPct(startLeftPct + ((e.clientX - startX) / gameRect.width) * 100, 0, Math.max(0, 100 - widthPct));
    g.topPct = clampPct(startTopPct + ((e.clientY - startY) / gameRect.height) * 100, 0, Math.max(0, 100 - heightPct));
    applyPanelGeometry(HUD_PANELS.find((p) => p.id === id));
  }
  if (hudResizeState) {
    const { id, startX, startY, startWidthPct, startHeightPct } = hudResizeState;
    const def = HUD_PANELS.find((p) => p.id === id);
    const g = hudCurrentLayout[id];
    const minWPct = (def.minW / gameRect.width) * 100;
    g.widthPct = clampPct(startWidthPct + ((e.clientX - startX) / gameRect.width) * 100, minWPct, 100 - g.leftPct);
    if (!def.noHeight) {
      const minHPct = (def.minH / gameRect.height) * 100;
      g.heightPct = clampPct(startHeightPct + ((e.clientY - startY) / gameRect.height) * 100, minHPct, 100 - g.topPct);
    } else {
      const body = el(id).querySelector(id === 'logPanel' ? '.log-body' : '.chat-body');
      if (hudResizeState.startBodyH === undefined) {
        hudResizeState.startBodyH = (body && body.getBoundingClientRect().height) || 240;
      }
      g.bodyMaxHeightPx = Math.max(120, Math.min(600, hudResizeState.startBodyH + (e.clientY - startY)));
    }
    applyPanelGeometry(def);
  }
});

document.addEventListener('mouseup', () => {
  if (hudDragState) {
    el(hudDragState.id).classList.remove('hud-dragging');
    hudDragState = null;
    persistHudLayout();
  }
  if (hudResizeState) {
    el(hudResizeState.id).classList.remove('hud-resizing');
    hudResizeState = null;
    persistHudLayout();
  }
});

function persistHudLayout() {
  const toSave = {};
  for (const { id } of HUD_PANELS) toSave[id] = hudCurrentLayout[id];
  saveHudLayoutStorage(toSave);
  saveHudLayoutToAccount(toSave);
}

// ---------- HUD layout <-> account sync ----------
// Local-first: every drag/resize always saves to localStorage instantly
// (persistHudLayout above), so the layout never depends on network access.
// When logged in, the same save is best-effort mirrored to the account so it
// follows the player across browsers/devices; on login (checked once per
// render() via syncHudLayoutWithAccount, keyed off the current token so it
// only actually fires again when the logged-in account changes) whatever
// the account has saved overrides the local copy.
function saveHudLayoutToAccount(panels) {
  const { token } = getStoredAccount();
  if (!token) return;
  fetch('api/hud-layout/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, layout: { v: HUD_LAYOUT_VERSION, panels } }),
  }).catch(() => {
    /* best-effort — account sync failing should never break the local layout */
  });
}

async function loadHudLayoutFromAccount(token) {
  try {
    const res = await fetch('api/hud-layout/load', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    const saved = data && data.layout && data.layout.v === HUD_LAYOUT_VERSION ? data.layout.panels : null;
    if (!saved || !hudDefaultLayout) return;
    hudCurrentLayout = {};
    for (const panel of HUD_PANELS) {
      hudCurrentLayout[panel.id] = { ...hudDefaultLayout[panel.id], ...(saved[panel.id] || {}) };
    }
    for (const panel of HUD_PANELS) applyPanelGeometry(panel);
    saveHudLayoutStorage(saved); // keep the local cache in sync with the account
  } catch {
    /* best-effort — no account layout yet, or the request failed */
  }
}

function syncHudLayoutWithAccount() {
  if (!hudLayoutInitialized) return;
  const { token } = getStoredAccount();
  if (token === hudAccountSyncedForToken) return;
  hudAccountSyncedForToken = token;
  if (token) loadHudLayoutFromAccount(token);
}

function toggleHudEditing() {
  hudEditing = !hudEditing;
  el('game').classList.toggle('hud-editing', hudEditing);
  el('hudEditToggle').classList.toggle('active', hudEditing);
  el('hudEditToggle').textContent = hudEditing ? '✓ Done Editing HUD' : '✥ Edit HUD Layout';
  el('hudResetLayout').classList.toggle('hidden', !hudEditing);
}

function resetHudLayout() {
  hudCurrentLayout = {};
  for (const { id } of HUD_PANELS) hudCurrentLayout[id] = { ...hudDefaultLayout[id] };
  for (const panel of HUD_PANELS) {
    applyPanelGeometry(panel);
    if (panel.noHeight) {
      const body = el(panel.id).querySelector(panel.id === 'logPanel' ? '.log-body' : '.chat-body');
      if (body) body.style.maxHeight = '';
    }
  }
  try {
    localStorage.removeItem(HUD_LAYOUT_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function initHudLayout() {
  const game = el('game');
  if (!game) return;

  // The one deliberate exception to "no reparenting" — these two are
  // viewport-fixed siblings of #game today, so they need a new containing
  // block to share the other 9 panels' coordinate space.
  const logPanel = el('logPanel');
  const chatPanel = el('chatPanel');
  if (logPanel && logPanel.parentElement !== game) game.appendChild(logPanel);
  if (chatPanel && chatPanel.parentElement !== game) game.appendChild(chatPanel);

  // Single measurement pass, BEFORE any panel becomes position:absolute, so
  // customizing one panel never perturbs another panel's captured default.
  const gameRect = game.getBoundingClientRect();
  const defaults = {};
  for (const panel of HUD_PANELS) {
    const elm = el(panel.id);
    if (!elm) continue;
    const geom = measurePanelPct(elm, gameRect, panel);
    if (panel.noHeight) delete geom.heightPct;
    defaults[panel.id] = geom;
  }
  hudDefaultLayout = defaults;

  const saved = loadHudLayoutStorage();
  hudCurrentLayout = {};
  for (const panel of HUD_PANELS) {
    hudCurrentLayout[panel.id] = { ...defaults[panel.id], ...((saved && saved[panel.id]) || {}) };
  }

  for (const panel of HUD_PANELS) applyPanelGeometry(panel);
  for (const panel of HUD_PANELS) injectHudHandles(panel);

  window.addEventListener('resize', () => HUD_PANELS.forEach((p) => syncHudOverlay(p.id)));
  el('hudEditToggle')?.addEventListener('click', toggleHudEditing);
  el('hudResetLayout')?.addEventListener('click', resetHudLayout);
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
  const player = mine ? currentView?.you : currentView?.opponent;
  who.textContent = displayName(player, owner) + ':';
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
  initLog();
  initTurnTimer();
  renderFactionThumbnails();
  loadRankings();
})();
