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

// Mirrors src/game/rules.js's buildDeck() copies formula exactly — that
// module is server-only (no bundler exposes it to this plain static
// client.js), so the deck-preview's quantity badges duplicate the same
// small, rarely-changed formula rather than adding a network round trip
// for something already derivable from data already in memory. Keep these
// two in sync if a future balance pass changes either one.
const FLAGSHIP_NAMES = new Set([
  'Dire Wolf', 'Sparkwright', 'The Creditor', 'Warden', 'Samurai',
  'Sharpshooter', 'Scavenger-Lord', 'Paladin', 'Berserker', 'Lich',
]);

function getDeckCopies(card) {
  return card.copies ?? (!FLAGSHIP_NAMES.has(card.name) && card.cost <= 3 ? 2 : 1);
}

// ---------- Lobby state ----------
let selectedFaction = null;
let selectedGameMode = 'ranked'; // 'ranked' | 'ai' — which lobby panel is showing, see initGameModeTabs()
let selectedDifficulty = 'normal'; // 'easy' | 'normal' | 'hard' — only meaningful when selectedGameMode === 'ai'
let ws = null;
let mySeatKey = null; // 'A' or 'B', informational only
let currentView = null;
let previousBoardIds = new Set();
let selectedHandCardId = null;
let selectedUnit = null; // { lane, slot } — your own unit selected as the acting unit for this turn: clicking a legal move destination moves it, clicking a legal enemy target/the castle attacks with it
let pendingSpell = null; // { card, hits: [] } — a hand spell awaiting a target click; hits accumulates split-damage picks
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

function selectFactionCard(card) {
  document.querySelectorAll('.faction-card').forEach((b) => b.classList.remove('selected'));
  card.classList.add('selected');
  selectedFaction = card.dataset.faction;
}

function initLobby() {
  el('factionPicker').addEventListener('click', (e) => {
    // .faction-card is a div (not a <button>) so it can legally contain the
    // View Deck button — that click must not also select the card.
    if (e.target.closest('.view-deck-btn')) return;
    const card = e.target.closest('.faction-card');
    if (!card) return;
    selectFactionCard(card);
  });
  el('factionPicker').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.faction-card');
    if (!card) return;
    e.preventDefault();
    selectFactionCard(card);
  });
  el('factionPicker').addEventListener('click', (e) => {
    const btn = e.target.closest('.view-deck-btn');
    if (!btn) return;
    e.stopPropagation();
    openDeckPreview(btn.closest('.faction-card').dataset.faction);
  });

  initGameModeTabs();

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

  el('playAiBtn').addEventListener('click', async () => {
    if (!selectedFaction) return setStatus('Pick a faction first.');
    setStatus('Starting AI match...');
    const res = await fetch('api/room', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'ai', difficulty: selectedDifficulty }),
    });
    const { code } = await res.json();
    connect(code);
  });
}

// Toggles between the "Ranked" (existing create/join-by-code) panel and the
// "AI Match" panel — reuses the same active/hidden toggle idiom as
// initRankingTabs() below, just with two panels' worth of content instead of
// two tables. The copy next to each tab is what makes the ranked-vs-practice
// distinction impossible to miss, per this feature's core requirement.
function initGameModeTabs() {
  el('modeTabRanked').addEventListener('click', () => {
    selectedGameMode = 'ranked';
    el('modeTabRanked').classList.add('active');
    el('modeTabAi').classList.remove('active');
    el('rankedPanel').classList.remove('hidden');
    el('aiMatchPanel').classList.add('hidden');
    setStatus('');
  });
  el('modeTabAi').addEventListener('click', () => {
    selectedGameMode = 'ai';
    el('modeTabAi').classList.add('active');
    el('modeTabRanked').classList.remove('active');
    el('aiMatchPanel').classList.remove('hidden');
    el('rankedPanel').classList.add('hidden');
    setStatus('');
  });
  el('difficultyPicker').addEventListener('click', (e) => {
    const btn = e.target.closest('.difficulty-btn');
    if (!btn) return;
    selectedDifficulty = btn.dataset.difficulty;
    document.querySelectorAll('.difficulty-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
}

function setStatus(text) {
  el('lobbyStatus').textContent = text;
}

function connect(code) {
  // A prior socket (e.g. an abandoned create/join attempt from earlier in
  // this tab) must be closed, not just overwritten — otherwise it keeps
  // receiving server messages and mutating the shared currentView/mySeatKey
  // out from under the connection the player actually cares about now.
  if (ws) ws.close();
  coinFlipAckSent = false;
  // Entering the HUD preview from here on would let hand/board clicks send
  // real game actions over this socket before a real match view ever
  // arrives — block it until we're either back at the lobby or a real
  // match has taken over the screen.
  el('customizeHudBtn').disabled = true;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/api/room/${code}/ws`);
  ws = socket;
  socket.addEventListener('message', (ev) => handleMessage(JSON.parse(ev.data)));
  socket.addEventListener('close', () => {
    setStatus('Disconnected from server.');
    // Only re-enable if this is still the live connection attempt — an
    // abandoned socket we just superseded above closing later must not
    // re-enable the button on behalf of the newer connection in flight.
    if (ws === socket && !currentView) el('customizeHudBtn').disabled = false;
  });
  socket.addEventListener('error', () => setStatus('Connection error.'));
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
      // A real match's first state can arrive while the player is still in
      // the lobby's HUD preview (e.g. the opponent joined while they were
      // customizing layout after creating a room). Drop the preview's fake
      // state and edit-mode UI cleanly so the real match starts fresh
      // instead of layering a live match under stale preview chrome.
      if (hudPreviewActive) {
        hudPreviewActive = false;
        if (hudEditing) toggleHudEditing();
        el('hudPreviewExitBtn').classList.add('hidden');
        previousView = null;
        previousBoardIds = new Set();
      }
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
      // Independent of phase — a Discover choice can be pending mid-deployment
      // or mid-combat, not just at specific phase boundaries like coinflip.
      renderDiscoverChoice(msg.pendingChoice);
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
  // Belt-and-suspenders against the disabled-button guard being bypassed —
  // a live/connecting match socket must never share the screen with the
  // fake preview view (see connect()'s comment for why).
  if (ws && ws.readyState !== WebSocket.CLOSED) return;
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

// A Discover-style effect (server-parked in game.pendingChoice) reveals 3
// real cards to the choosing player only — the opponent's redacted view
// just carries `{owner, waiting:true}`, so this renders a "waiting" message
// for them instead of the picker.
function renderDiscoverChoice(pendingChoice) {
  const overlay = el('discoverOverlay');
  if (!pendingChoice) {
    overlay.classList.add('hidden');
    return;
  }
  overlay.classList.remove('hidden');
  const optionsEl = el('discoverOptions');
  const waitingEl = el('discoverWaiting');
  if (pendingChoice.waiting) {
    optionsEl.classList.add('hidden');
    waitingEl.classList.remove('hidden');
    return;
  }
  waitingEl.classList.add('hidden');
  optionsEl.classList.remove('hidden');
  optionsEl.innerHTML = '';
  pendingChoice.options.forEach((option, index) => {
    const cardEl = buildCardEl(option, { context: 'board' });
    cardEl.classList.add('discover-option');
    cardEl.addEventListener('click', () => send({ type: 'discover_choice', index }));
    optionsEl.appendChild(cardEl);
  });
}

// ---------- Rendering ----------
// Card-render migration Phase 2: turns a card's free-text `text` field into
// an array of legible ability lines, for the live template renderer Phase 3
// will build. Not wired into buildCardEl()/showPreview() yet — those still
// render the legacy baked-JPG-per-card path until Phase 3 replaces it.
//
// Splitting rule (tuned against the actual 374-card corpus, not guessed):
// 1. Split on ALLCAPS clause boundaries ("TAUNT: ...", "PACK HUNT: ...") —
//    the same visual signal detectKeywords() already relies on for keyword
//    DETECTION, reused here for line SEGMENTATION instead. Handles all 6
//    existing two-ability cards (beast_15/18, dwarf_17, fallen_16, orc_22,
//    undead_22).
// 2. A trailing "(...)" flavor parenthetical with no keyword-colon inside it
//    (the flagship pattern, e.g. "...(This unit is a rare, high-impact
//    threat.)") is carved into its own footer line, since it's flavor text
//    rather than another ability and shouldn't count toward line density.
// 3. No ALLCAPS match at all (plain spell text like "Draw 4 cards.") returns
//    the whole text as one line — correct as-is, needs no splitting help.
// No generic sentence-boundary fallback: the current corpus has zero cards
// with 3+ sentences or multi-sentence plain (non-keyword) text, so that
// would be speculative complexity for a shape that doesn't exist yet. If a
// future card needs it, extend this function then.
function splitAbilityLines(text) {
  const t = (text || '').trim();
  if (!t) return { lines: [], footer: null };

  const KEYWORD_CLAUSE = /[A-Z][A-Z ]{2,}:\s*/g;
  const matches = [...t.matchAll(KEYWORD_CLAUSE)];
  let segments;
  if (matches.length === 0) {
    segments = [t];
  } else {
    segments = [];
    const firstStart = matches[0].index;
    if (firstStart > 0) {
      const lead = t.slice(0, firstStart).trim();
      if (lead) segments.push(lead);
    }
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index;
      const end = i + 1 < matches.length ? matches[i + 1].index : t.length;
      segments.push(t.slice(start, end).trim());
    }
  }

  // Carve a trailing flavor parenthetical off the LAST segment only, and
  // only if it isn't the segment's entire content (which would otherwise
  // leave an empty ability line) and doesn't itself contain a keyword clause
  // (which would mean it's really another ability, not flavor text).
  let footer = null;
  if (segments.length > 0) {
    const last = segments[segments.length - 1];
    const footerMatch = last.match(/\s*(\([^()]*\))\s*$/);
    if (footerMatch) {
      const candidate = footerMatch[1];
      if (candidate.length < last.length && !KEYWORD_CLAUSE.test(candidate)) {
        footer = candidate;
        segments[segments.length - 1] = last.slice(0, footerMatch.index).trim();
      }
    }
  }

  return { lines: segments.filter(Boolean), footer };
}

// Card-render migration Phase 3C: composites the live template layers —
// clean art (cropped by cardsource/extract_art.ps1, Phase 3B), the card
// name, and its ability lines (via splitAbilityLines, Phase 2) — into any
// given container. The template frame itself is applied as `container`'s
// own CSS background-image (see .card-templated in style.css), not a DOM
// layer, so it never needs its own stacking/z-index bookkeeping. Stat
// numbers are deliberately never drawn here — see renderStatBadges below,
// the one place they still appear, satisfying the physical-card/game-board
// split without any separate "remove stats" step.
function renderCardFace(container, instance) {
  container.innerHTML = '';
  container.classList.add('card-templated');

  const faction = instance.cardId ? instance.cardId.split('_')[0] : '';
  // extract_art.ps1's output is keyed by cardId, not by the legacy `image`
  // path's filename (which is slug-based, e.g. "01_ashigaru.jpg", and can't
  // be derived from cardId alone) — falls back to the old baked image only
  // if cardId is somehow missing, so nothing renders as a broken image.
  const artSrc = faction ? `assets/cards/art/${faction}/${instance.cardId}.png` : instance.image;

  // extract_art.ps1 cropped the art-window rectangle straight out of each
  // card's old fully-composited JPG, which included that template's own
  // dark radial vignette fading in from the window's edges — invisible on
  // a ~100px hand/grid tile, but glaring once magnified in the hover
  // preview. .card-art-frame clips an oversized, cover-fit + scaled image
  // so only the brighter center of that crop is ever shown, cropping the
  // vignette out rather than displaying it.
  const artFrame = document.createElement('div');
  artFrame.className = 'card-art-frame';
  const art = document.createElement('img');
  art.className = 'card-art';
  art.src = artSrc;
  art.alt = '';
  artFrame.appendChild(art);
  container.appendChild(artFrame);

  const namePlate = document.createElement('div');
  namePlate.className = 'card-name-plate';
  namePlate.textContent = instance.name;
  container.appendChild(namePlate);

  const rulesPanel = document.createElement('div');
  rulesPanel.className = 'card-rules-panel';
  const { lines, footer } = splitAbilityLines(instance.text);
  for (const line of lines) {
    const lineEl = document.createElement('div');
    lineEl.className = 'ability-line';
    lineEl.textContent = line;
    rulesPanel.appendChild(lineEl);
  }
  if (footer) {
    const footerEl = document.createElement('div');
    footerEl.className = 'ability-footer';
    footerEl.textContent = footer;
    rulesPanel.appendChild(footerEl);
  }
  container.appendChild(rulesPanel);
}

// The only place cost/DMG/HP/countdown ever appear — a small always-current
// DOM layer that was already separate from the card art before this
// migration (previously duplicating numbers also baked into the old JPG).
function renderStatBadges(container, instance) {
  const cost = document.createElement('span');
  cost.className = 'card-badge cost-badge';
  cost.textContent = instance.cost;
  container.append(cost);
  if (instance.type !== 'spell') {
    const dmg = document.createElement('span');
    dmg.className = 'card-badge dmg-badge';
    dmg.textContent = instance.displayPower ?? instance.power;
    const hp = document.createElement('span');
    hp.className = 'card-badge hp-badge';
    hp.textContent = instance.defense;
    container.append(dmg, hp);
  }
  if (instance.countdown !== null && instance.countdown !== undefined) {
    const cd = document.createElement('span');
    cd.className = 'card-badge countdown-badge';
    cd.textContent = `⏳${instance.countdown}`;
    container.appendChild(cd);
  }
}

function buildCardEl(instance, { context = 'board' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'card' + (context === 'hand' ? ' hand-card' : '');
  if (!instance || instance.hidden) {
    wrap.classList.add('face-down');
    return wrap;
  }

  wrap.dataset.instanceId = instance.instanceId;
  renderCardFace(wrap, instance);
  wrap.title = `${instance.name}\n${instance.text || ''}`;

  renderStatBadges(wrap, instance);
  if (instance.type === 'spell') wrap.classList.add('spell-card');

  if (instance.sick) wrap.classList.add('sick');
  if (instance.attackedThisTurn) wrap.classList.add('attacked');

  wrap.addEventListener('mouseenter', () => showPreview(instance, wrap));
  wrap.addEventListener('mouseleave', hidePreview);
  // Touch has no hover — tapping a card (which already selects/plays/
  // attacks with it via the click listener wired at the call site) also
  // shows the same preview a mouse user gets from hovering, so a touch
  // player can actually read what they just tapped. Harmless alongside the
  // hover listener for mouse users (already visible by the time a click
  // could fire). Dismissed by the global "tap elsewhere" listener below.
  wrap.addEventListener('click', () => showPreview(instance, wrap));

  return wrap;
}

function showPreview(instance, sourceEl) {
  if (!instance.image) return;
  const preview = el('cardPreview');
  renderCardFace(preview, instance);
  renderStatBadges(preview, instance);
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

// Tapping any card shows its preview (see buildCardEl) with no matching
// "leave" event on touch to hide it again — this is the global dismiss:
// tap anywhere that isn't a card (the board, a panel, the preview overlay
// itself) and it closes. Idempotent and harmless outside a live match too.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.card')) hidePreview();
});

// ---------- Deck selection & preview ----------
// The lobby's faction picker doubles as a fixed-deck picker (no player
// deckbuilding exists — buildDeck() in rules.js just expands every card in
// a faction's JSON into copies and shuffles). Everything below is read-only
// presentation over factionData, already fully loaded by loadFactionData()
// before initLobby() runs — no new network calls.

let deckPreviewFaction = null;

function renderDeckBadgeRow(factionKey) {
  const data = factionData[factionKey];
  const card = document.querySelector(`.faction-card[data-faction="${factionKey}"]`);
  if (!data || !card) return;
  const badgeRow = card.querySelector('.deck-badge-row');
  if (badgeRow) {
    badgeRow.innerHTML = '';
    if (data.archetype) {
      const archPill = document.createElement('span');
      archPill.className = 'deck-badge';
      archPill.textContent = data.archetype;
      badgeRow.appendChild(archPill);
    }
    if (data.difficulty) {
      const diffPill = document.createElement('span');
      diffPill.className = 'deck-badge deck-badge-difficulty';
      diffPill.dataset.difficulty = data.difficulty;
      diffPill.textContent = data.difficulty;
      badgeRow.appendChild(diffPill);
    }
  }
  const taglineEl = card.querySelector('.deck-tagline');
  if (taglineEl) taglineEl.textContent = data.tagline || '';
}

function computeDeckStats(factionKey) {
  const cards = (factionData[factionKey] && factionData[factionKey].cards) || [];
  let deckSize = 0;
  let costSum = 0;
  let units = 0;
  let spells = 0;
  const curve = {};
  for (const card of cards) {
    const copies = getDeckCopies(card);
    deckSize += copies;
    costSum += card.cost * copies;
    if (card.type === 'spell') spells += copies;
    else units += copies;
    const bucket = card.cost >= 8 ? '8+' : String(card.cost);
    curve[bucket] = (curve[bucket] || 0) + copies;
  }
  return {
    uniqueCount: cards.length,
    deckSize,
    avgCost: deckSize ? costSum / deckSize : 0,
    units,
    spells,
    curve,
  };
}

function renderDeckBulletList(id, items) {
  const listEl = el(id);
  listEl.innerHTML = '';
  (items || []).forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item;
    listEl.appendChild(li);
  });
}

const MANA_CURVE_BUCKETS = ['0', '1', '2', '3', '4', '5', '6', '7', '8+'];

function renderDeckStats(factionKey) {
  const stats = computeDeckStats(factionKey);
  el('deckStatTotal').textContent = stats.deckSize;
  el('deckStatUnique').textContent = stats.uniqueCount;
  el('deckStatAvgCost').textContent = stats.avgCost.toFixed(1);
  el('deckStatUnits').textContent = stats.units;
  el('deckStatSpells').textContent = stats.spells;

  const curveEl = el('deckPreviewCurve');
  curveEl.innerHTML = '';
  const maxCount = Math.max(1, ...MANA_CURVE_BUCKETS.map((b) => stats.curve[b] || 0));
  MANA_CURVE_BUCKETS.forEach((bucket) => {
    const count = stats.curve[bucket] || 0;
    const col = document.createElement('div');
    col.className = 'mana-curve-col';
    const bar = document.createElement('div');
    bar.className = 'mana-curve-bar';
    bar.style.height = `${Math.max(2, (count / maxCount) * 100)}%`;
    bar.title = `${count} card${count === 1 ? '' : 's'} at cost ${bucket}`;
    const label = document.createElement('span');
    label.className = 'mana-curve-label';
    label.textContent = bucket;
    col.append(bar, label);
    curveEl.appendChild(col);
  });
}

function getFilteredSortedCards(factionKey) {
  const cards = (factionData[factionKey] && factionData[factionKey].cards) || [];
  const search = el('deckSearchInput').value.trim().toLowerCase();
  const typeFilter = el('deckTypeFilter').value;
  const costFilter = el('deckCostFilter').value;
  const sort = el('deckSortSelect').value;

  const filtered = cards.filter((card) => {
    if (search && !card.name.toLowerCase().includes(search)) return false;
    const type = card.type === 'spell' ? 'spell' : 'unit';
    if (typeFilter !== 'all' && type !== typeFilter) return false;
    if (costFilter !== 'all') {
      if (costFilter === '8+' ? card.cost < 8 : card.cost !== Number(costFilter)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'type') return (a.type || 'unit').localeCompare(b.type || 'unit') || a.cost - b.cost;
    return a.cost - b.cost || a.name.localeCompare(b.name);
  });

  return filtered;
}

function buildDeckPreviewCardEl(card) {
  const instance = demoCardInstance(card);
  const cardEl = buildCardEl(instance, { context: 'board' });
  // .card's own aspect-ratio + container-type:size sizing (needed for its
  // cqw/cqh text) turned out unreliable as a direct CSS Grid item in at
  // least one real browser — collapsed to a thin sliver instead of a 2:3
  // box. A .deck-card-tile wrapper using the old padding-top intrinsic-ratio
  // technique sidesteps that ambiguity entirely: the tile's height comes
  // from padding (pure width-derived math, no aspect-ratio/Grid interplay),
  // and .card fills it via inset:0.
  const tile = document.createElement('div');
  tile.className = 'deck-card-tile';
  tile.appendChild(cardEl);
  const copies = getDeckCopies(card);
  const qty = document.createElement('span');
  qty.className = 'deck-card-qty';
  qty.textContent = `×${copies}`;
  tile.appendChild(qty);
  // buildCardEl already wires hover-to-preview; this adds tap-to-preview for
  // touch devices, which never fire mouseenter.
  tile.addEventListener('click', (e) => {
    e.stopPropagation();
    showPreview(instance, tile);
  });
  return tile;
}

function renderDeckCardGrid(factionKey) {
  const grid = el('deckCardGrid');
  grid.innerHTML = '';
  const cards = getFilteredSortedCards(factionKey);
  if (cards.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'deck-card-grid-empty';
    empty.textContent = 'No cards match those filters.';
    grid.appendChild(empty);
    return;
  }
  cards.forEach((card) => grid.appendChild(buildDeckPreviewCardEl(card)));
}

function openDeckPreview(factionKey) {
  const data = factionData[factionKey];
  if (!data) return;
  deckPreviewFaction = factionKey;

  el('deckPreviewName').textContent = data.displayName;
  el('deckPreviewArchetype').textContent = data.archetype || '';
  el('deckPreviewDifficulty').textContent = data.difficulty || '';
  el('deckPreviewDifficulty').dataset.difficulty = data.difficulty || '';
  el('deckPreviewDescription').textContent = data.description || '';
  el('deckPreviewGamePlan').textContent = data.gamePlan || '';
  el('deckPreviewPlaystyle').textContent = data.playstyle || '';
  el('deckPreviewWinCondition').textContent = data.winCondition || '';

  const beginnerBlock = el('deckPreviewBeginnerBlock');
  if (data.beginnerExplainer) {
    el('deckPreviewBeginner').textContent = data.beginnerExplainer;
    beginnerBlock.classList.remove('hidden');
  } else {
    beginnerBlock.classList.add('hidden');
  }

  renderDeckBulletList('deckPreviewStrengths', data.strengths);
  renderDeckBulletList('deckPreviewWeaknesses', data.weaknesses);
  renderDeckBulletList('deckPreviewPros', data.pros);
  renderDeckBulletList('deckPreviewCons', data.cons);

  const mechanicsEl = el('deckPreviewMechanics');
  mechanicsEl.innerHTML = '';
  (data.keyMechanics || []).forEach((mechanic) => {
    const chip = document.createElement('span');
    chip.className = 'deck-mechanic-chip';
    chip.textContent = mechanic;
    mechanicsEl.appendChild(chip);
  });

  const howToPlay = data.howToPlay || {};
  el('deckPreviewEarly').textContent = howToPlay.early || '';
  el('deckPreviewMid').textContent = howToPlay.mid || '';
  el('deckPreviewLate').textContent = howToPlay.late || '';

  renderDeckStats(factionKey);

  el('deckSearchInput').value = '';
  el('deckTypeFilter').value = 'all';
  el('deckCostFilter').value = 'all';
  el('deckSortSelect').value = 'cost';
  renderDeckCardGrid(factionKey);

  el('deckPreviewOverlay').classList.remove('hidden');
}

function closeDeckPreview() {
  el('deckPreviewOverlay').classList.add('hidden');
  hidePreview();
  deckPreviewFaction = null;
}

function renderDeckCompareTable() {
  const body = el('deckCompareTableBody');
  body.innerHTML = '';
  FACTION_KEYS.forEach((key) => {
    const data = factionData[key];
    if (!data) return;
    const tr = document.createElement('tr');
    const cells = [
      data.displayName,
      data.archetype || '',
      data.difficulty || '',
      (data.strengths && data.strengths[0]) || '',
      (data.weaknesses && data.weaknesses[0]) || '',
    ];
    cells.forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
}

function initDeckPreview() {
  el('deckPreviewCloseBtn').addEventListener('click', closeDeckPreview);
  el('deckPreviewSelectBtn').addEventListener('click', () => {
    if (!deckPreviewFaction) return;
    const card = document.querySelector(`.faction-card[data-faction="${deckPreviewFaction}"]`);
    if (card) selectFactionCard(card);
    closeDeckPreview();
  });
  el('deckSearchInput').addEventListener('input', () => renderDeckCardGrid(deckPreviewFaction));
  el('deckTypeFilter').addEventListener('change', () => renderDeckCardGrid(deckPreviewFaction));
  el('deckCostFilter').addEventListener('change', () => renderDeckCardGrid(deckPreviewFaction));
  el('deckSortSelect').addEventListener('change', () => renderDeckCardGrid(deckPreviewFaction));
  // Clicking anywhere in the info/filter area that isn't a card tile should
  // dismiss any tap-pinned preview from buildDeckPreviewCardEl's click handler.
  el('deckPreviewBody').addEventListener('click', (e) => {
    if (!e.target.closest('.card')) hidePreview();
  });

  el('compareDecksBtn').addEventListener('click', () => {
    renderDeckCompareTable();
    el('deckCompareOverlay').classList.remove('hidden');
  });
  el('deckCompareCloseBtn').addEventListener('click', () => el('deckCompareOverlay').classList.add('hidden'));
}

function renderCastle(sidePanelId, hp, maxHp, faction) {
  const sidePanel = el(sidePanelId);
  const img = sidePanel.querySelector('.castle-img');
  img.src = `assets/cards/${faction}castle.png`;
  img.alt = `${faction} castle`;
  const clampedHp = Math.max(0, hp);
  sidePanel.querySelector('.castle-hp-value').textContent = `${clampedHp} / ${maxHp}`;
  const ratio = maxHp > 0 ? Math.max(0, hp / maxHp) : 0;
  sidePanel.querySelector('.castle-hp-bar-fill').style.width = `${ratio * 100}%`;
  const damaged = hp > 0 && ratio < 0.66;
  const critical = hp > 0 && ratio < 0.33;
  const destroyed = hp <= 0;
  sidePanel.classList.toggle('castle-damaged', damaged);
  sidePanel.classList.toggle('castle-critical', critical);
  sidePanel.classList.toggle('castle-destroyed', destroyed);
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
    // lastPlayedCard (fx.card) is a small broadcast summary, not a full
    // makeCardInstance() object — it has no power/defense, so this renders
    // art+name+rules text only, no stat badges (the reveal was never meant
    // to show full stats; the board/hand already do).
    renderCardFace(el('cardRevealImg'), fx.card);
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
  const { you, opponent, turn, phase, turnNumber, winner, log, you_key, mode } = currentView;
  const myTurn = turn === you_key;
  const oppKey = you_key === 'A' ? 'B' : 'A';

  el('youInfo').querySelector('.name').textContent = displayName(you, you_key);
  el('youInfo').querySelector('.faction-tag').textContent = capitalize(you.faction);
  renderCastle('youPanel', you.hp, you.maxHp, you.faction);
  el('youInfo').querySelector('.mana').textContent = `${you.mana}/${you.maxMana}`;
  renderManaCrystals(el('youInfo').querySelector('.mana-crystals'), you.mana, you.maxMana);

  el('oppInfo').querySelector('.name').textContent = displayName(opponent, oppKey);
  el('oppInfo').querySelector('.faction-tag').textContent = capitalize(opponent.faction);
  renderCastle('oppPanel', opponent.hp, opponent.maxHp, opponent.faction);
  el('oppInfo').querySelector('.mana').textContent = `${opponent.mana}/${opponent.maxMana}`;
  renderManaCrystals(el('oppInfo').querySelector('.mana-crystals'), opponent.mana, opponent.maxMana);

  el('turnIndicatorText').textContent = winner
    ? 'Game Over'
    : mode === 'ai' && !myTurn
    ? `Turn ${turnNumber} — 🤖 AI is thinking… (${phase})`
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
  // Surrendering isn't a turn action — usable on either player's turn, any
  // phase once the match is actually underway.
  el('surrenderBtn').disabled = !!winner || phase === 'coinflip';

  el('log').innerHTML = '';
  for (const line of log) {
    el('log').appendChild(buildLogLine(line));
  }
  el('log').scrollTop = el('log').scrollHeight;

  highlightSelections();

  if (winner) {
    el('gameOverOverlay').classList.remove('hidden');
    el('gameOverText').textContent = winner === you_key ? 'Victory!' : 'Defeat...';
    const aiNote = el('gameOverAiNote');
    if (aiNote) {
      aiNote.classList.toggle('hidden', mode !== 'ai');
      if (mode === 'ai') {
        aiNote.textContent = `${opponent.username || 'AI Match'} — this result does not affect your Ranked rating or statistics.`;
      }
    }
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
      cardEl.addEventListener('pointerdown', (e) => onCardPointerDown(e, side, laneName, slotIndex));
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
  if (kind === 'empty_ally_slot' && side === 'you' && !you.board[lane][slotIndex]) {
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

function onCardPointerDown(e, side, lane, slotIndex) {
  if (side !== 'you') return;
  const { turn, phase, you_key } = currentView || {};
  if (turn !== you_key || phase !== 'combat' || autoAttackRunning) return;
  const unit = currentView.you.board[lane][slotIndex];
  if (!unit || unit.sick || unit.attackedThisTurn) return;
  // Pointer Events (not separate mouse/touch listeners) so mouse-drag and
  // finger-drag share this exact same path — .slot .card's touch-action:none
  // (style.css) stops the browser from treating this as a page-scroll
  // gesture and eating the pointermove events before they reach us.
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

document.addEventListener('pointermove', (e) => {
  if (isDragging) {
    updateArrowTo(e.clientX, e.clientY);
    return;
  }
  if (!dragCandidate) return;
  const dist = Math.hypot(e.clientX - dragCandidate.startX, e.clientY - dragCandidate.startY);
  if (dist > DRAG_THRESHOLD) beginDrag(e.clientX, e.clientY);
});

document.addEventListener('pointerup', (e) => {
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
    } else if (kind === 'empty_ally_slot') {
      for (const laneName of ['vanguard', 'rearguard']) {
        const containerId = laneName === 'vanguard' ? 'youVanguard' : 'youRearguard';
        document.querySelectorAll(`#${containerId} .slot`).forEach((s, idx) => {
          if (!currentView.you.board[laneName][idx]) s.classList.add('spell-target');
        });
      }
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
el('surrenderBtn')?.addEventListener('click', () => {
  if (!confirm('Surrender this match? This immediately ends the game as a loss.')) return;
  send({ type: 'surrender' });
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
// Bumped: oppInfo/youInfo's default position moved (board corners, then
// back to flanking the turn indicator) — old saved coordinates for those
// two would otherwise render in a spot that no longer matches either
// layout's intent. Discarding all saved layouts on a bump is deliberate;
// affected players just see the new default and can re-customize.
const HUD_LAYOUT_VERSION = 2;

const HUD_PANELS = [
  { id: 'oppInfo', label: 'Enemy Info', minW: 150, minH: 50 },
  { id: 'turnIndicator', label: 'Turn Timer', minW: 120, minH: 40 },
  { id: 'youInfo', label: 'Your Info', minW: 150, minH: 50 },
  { id: 'oppPanel', label: 'Enemy Stats', minW: 70, minH: 140 },
  { id: 'boardArea', label: 'Battlefield', minW: 320, minH: 220 },
  { id: 'youPanel', label: 'Your Stats', minW: 70, minH: 140 },
  { id: 'controls', label: 'Controls', minW: 280, minH: 50 },
  { id: 'hand', label: 'Your Hand', minW: 160, minH: 120 },
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

// Log/Chat float above the whole HUD and must never be clipped by #game's
// overflow:hidden — before the layout manager they were plain
// position:fixed siblings of #game, so pinning them absolute (like the
// other 9 panels) confined them to #game's box and let an expanded
// .log-body/.chat-body get cut off at its edge instead of overlaying
// everything, and let opening them affect page layout/scroll. They keep
// position:fixed here, with left/top/width recomputed as viewport pixels
// from #game's current rect every time geometry is (re)applied.
function isFloatingHudPanel(id) {
  return id === 'logPanel' || id === 'chatPanel';
}

// logPanel/chatPanel's collapsed (toggle-button-only) height in px, captured
// once per panel the first time geometry is measured — see the comment in
// applyPanelGeometry() for why this is the anchor, not their top position.
let hudFloatingCollapsedHeight = {};

// Free-form drag/resize is a desktop power-user feature — the HUD_PANELS'
// own configured minimums (boardArea 320 + hand 160 = 480px) already exceed
// a phone's entire width, so below this breakpoint every non-floating panel
// falls back to a dedicated mobile CSS grid instead (see the
// max-width:760px block in style.css) rather than fighting drag/resize math
// that can't work with a fingertip on a screen this size.
function isMobileLayout() {
  return window.innerWidth <= 760;
}

function applyPanelGeometry(panel) {
  const panelEl = el(panel.id);
  const geom = hudCurrentLayout[panel.id];
  if (!panelEl || !geom) return;
  if (!isFloatingHudPanel(panel.id) && isMobileLayout()) {
    // Clears back to whatever the stylesheet's grid-area says — the exact
    // fallback position every panel already has for the one frame before
    // this function first runs on desktop, just made permanent here.
    panelEl.style.position = '';
    panelEl.style.gridArea = '';
    panelEl.style.left = '';
    panelEl.style.top = '';
    panelEl.style.width = '';
    panelEl.style.height = '';
    panelEl.style.zIndex = '';
    syncHudOverlay(panel.id);
    return;
  }
  if (isFloatingHudPanel(panel.id)) {
    const gameRect = el('game').getBoundingClientRect();
    // These open upward from a fixed point near the screen edge (matching
    // their pre-HUD-manager behavior), so they must be anchored by `bottom`,
    // not `top`: with `top` pinned, an expanding .log-body/.chat-body pushes
    // the box's bottom edge (and thus the newly-revealed content) further
    // down the screen — invisible below the fold for a panel that lives near
    // the bottom. Anchoring by `bottom` instead means growth pushes the TOP
    // edge upward, so the expanded panel appears above the toggle button,
    // in the free space, exactly like before. The anchor point itself is
    // still whatever `topPct` dragging left it at, converted to a `bottom`
    // offset using the panel's known COLLAPSED height (not its current,
    // possibly-expanded one — using the live height here would make the
    // anchor drift a little further every time it's applied while open).
    const topPx = gameRect.top + (geom.topPct / 100) * gameRect.height;
    const collapsedHeight = hudFloatingCollapsedHeight[panel.id] || 0;
    panelEl.style.position = 'fixed';
    panelEl.style.left = `${gameRect.left + (geom.leftPct / 100) * gameRect.width}px`;
    panelEl.style.bottom = `${window.innerHeight - (topPx + collapsedHeight)}px`;
    panelEl.style.width = `${(geom.widthPct / 100) * gameRect.width}px`;
    // The stylesheet anchors these to the right/top edge by default —
    // left+right or top+bottom both set (with height/width auto) stretches
    // the box per spec, so the offsets we're not using must be cleared.
    panelEl.style.right = 'auto';
    panelEl.style.top = 'auto';
  } else {
    panelEl.style.position = 'absolute';
    // A grid item that becomes position:absolute keeps its assigned grid area
    // as its containing block for percentage resolution (per spec) unless
    // fully detached from grid placement — without this, width/height percentages
    // resolve against the old (possibly collapsed) grid cell instead of #game.
    panelEl.style.gridArea = 'auto';
    panelEl.style.left = `${geom.leftPct}%`;
    panelEl.style.top = `${geom.topPct}%`;
    panelEl.style.width = `${geom.widthPct}%`;
    if (!panel.noHeight) panelEl.style.height = `${geom.heightPct}%`;
    // Every in-game panel must paint above the battlefield no matter how
    // it's dragged. None of these 9 set a z-index, so with position:absolute
    // and z-index:auto they stack in plain DOM order — and the battlefield
    // happens to sit between the enemy-stats and player-stats panels in the
    // markup, silently burying whichever one gets dragged over it while the
    // one declared after it in the HTML keeps showing through untouched.
    panelEl.style.zIndex = panel.id === 'boardArea' ? '1' : '2';
  }
  if (panel.noHeight && geom.bodyMaxHeightPx) {
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
  // oppInfo/turnIndicator/youInfo are laid out as one centered cluster in
  // the middle of #topBar, not oppInfo/youInfo pinned to its outer edges
  // with turnIndicator stretched to fill whatever's left — that spread them
  // to the far screen corners, away from the turn text they're meant to
  // flank. #topBar spans the whole grid row regardless of its children
  // (reliable even before layout settles), but the children's own natural
  // flex position was NOT reliable to capture here: the moment they're
  // converted to position:absolute a few lines down, they stop contributing
  // to #topBar's flex height, so #topBar (and thus a self-measured panel's
  // captured position) visibly collapses back down around whichever child
  // remains — a minor rounding difference when these panels were small, but
  // real overlap once they got bigger and don't shrink to fit anymore.
  const topBarRect = el('topBar')?.getBoundingClientRect();
  // Capped as a fraction of the actual game width, not a flat 220px — two
  // fixed-width panels plus the turn indicator between them can otherwise
  // add up to more than a narrow window actually has. Floored at .hp-panel's
  // own CSS min-width (150px, matching HUD_PANELS' minW below) so this
  // never computes a narrower width than the browser will actually render —
  // that mismatch is what left turnIndicator's position overlapping oppInfo
  // on a narrow window (oppInfo renders at its CSS floor while turnIndicator
  // gets positioned as though oppInfo were narrower than that).
  const infoPanelWidth = topBarRect ? Math.max(150, Math.min(220, gameRect.width * 0.22)) : 220;
  const gap = 16;
  const turnIndicatorEl = el('turnIndicator');
  // Still measured from its own natural (pre-detach) width — only its
  // CENTERING within the cluster is now explicit, not "whatever's left."
  const turnIndicatorWidth = topBarRect && turnIndicatorEl
    ? Math.min(420, Math.max(120, turnIndicatorEl.getBoundingClientRect().width))
    : 0;
  const clusterWidth = infoPanelWidth * 2 + gap * 2 + turnIndicatorWidth;
  // Clamped so an extremely narrow window (the cluster's own floors adding
  // up to more width than #topBar actually has) anchors to one edge instead
  // of centering symmetrically off-screen on both sides at once.
  const clusterLeft = topBarRect
    ? Math.max(gameRect.left, Math.min(topBarRect.left + (topBarRect.width - clusterWidth) / 2, gameRect.right - clusterWidth))
    : 0;
  for (const panel of HUD_PANELS) {
    const elm = el(panel.id);
    if (!elm) continue;
    let geom;
    if (topBarRect && (panel.id === 'oppInfo' || panel.id === 'youInfo')) {
      // Deliberately NOT tied to topBarRect.height (unlike turnIndicator
      // below) — the player wants these thinner than the turn indicator,
      // not matched to it.
      const height = 58;
      const left = panel.id === 'oppInfo' ? clusterLeft : clusterLeft + infoPanelWidth + gap + turnIndicatorWidth + gap;
      // Centered within #topBar's own (taller) height rather than
      // top-aligned, since it's now deliberately shorter than the row.
      const top = topBarRect.top + (topBarRect.height - height) / 2;
      geom = {
        leftPct: ((left - gameRect.left) / gameRect.width) * 100,
        topPct: ((top - gameRect.top) / gameRect.height) * 100,
        widthPct: (infoPanelWidth / gameRect.width) * 100,
        heightPct: (height / gameRect.height) * 100,
      };
    } else if (topBarRect && panel.id === 'turnIndicator') {
      const left = clusterLeft + infoPanelWidth + gap;
      const height = Math.max(topBarRect.height, 80);
      geom = {
        leftPct: ((left - gameRect.left) / gameRect.width) * 100,
        topPct: ((topBarRect.top - gameRect.top) / gameRect.height) * 100,
        widthPct: (turnIndicatorWidth / gameRect.width) * 100,
        heightPct: (height / gameRect.height) * 100,
      };
    } else {
      geom = measurePanelPct(elm, gameRect, panel);
    }
    if (panel.noHeight) delete geom.heightPct;
    defaults[panel.id] = geom;
    // Captured here specifically because log/chat are still governed by
    // their original stylesheet position (collapsed) at this point in the
    // very first call — see applyPanelGeometry() for why this height, not
    // whatever the panel's current height happens to be, is the anchor.
    if (isFloatingHudPanel(panel.id) && !(panel.id in hudFloatingCollapsedHeight)) {
      hudFloatingCollapsedHeight[panel.id] = elm.getBoundingClientRect().height;
    }
  }
  hudDefaultLayout = defaults;

  const saved = loadHudLayoutStorage();
  hudCurrentLayout = {};
  for (const panel of HUD_PANELS) {
    hudCurrentLayout[panel.id] = { ...defaults[panel.id], ...((saved && saved[panel.id]) || {}) };
  }

  for (const panel of HUD_PANELS) applyPanelGeometry(panel);
  for (const panel of HUD_PANELS) injectHudHandles(panel);

  // Re-applies full geometry, not just the overlay sync — the floating
  // log/chat panels store pixel coordinates derived from #game's rect at
  // apply-time, so a viewport resize must recompute those pixels or they'd
  // drift away from the rest of the HUD instead of scaling with it.
  window.addEventListener('resize', () => HUD_PANELS.forEach((p) => applyPanelGeometry(p)));
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
  loadAiStats();
}

// Kept entirely separate from loadRankings()/the ranked leaderboard below —
// AI wins/losses live in their own AccountsRegistry storage key
// (see /api/ai-stats) and must never be blended into ranked numbers.
async function loadAiStats() {
  const stored = getStoredAccount();
  const line = el('aiStatsLine');
  if (!line) return;
  if (!stored.token) {
    line.textContent = '';
    return;
  }
  try {
    const res = await fetch('api/ai-stats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: stored.token }),
    });
    const data = await res.json();
    line.textContent = `AI Practice: ${data.wins || 0}W / ${data.losses || 0}L`;
  } catch {
    /* best-effort, non-critical UI */
  }
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
  if (factions.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="4">No deck stats yet — play a ranked match to see win rates here.</td></tr>';
    return;
  }
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
  // A slow connection previously left both tables bare (just headers, no
  // rows) with nothing to tell the player it was still loading — looked
  // indistinguishable from broken.
  const loadingRow = '<tr class="loading-row"><td colspan="4">Loading rankings…</td></tr>';
  el('playersTableBody').innerHTML = loadingRow;
  el('decksTableBody').innerHTML = loadingRow;
  try {
    const res = await fetch('api/rankings');
    const data = await res.json();
    renderPlayerRankings(data.players || []);
    renderFactionRankings(data.factions || [], data.minFactionGames || 5);
  } catch {
    // Rankings are a nice-to-have on the lobby screen — a failed fetch
    // shouldn't block anything else, but it shouldn't look broken either.
    const errorRow = '<tr class="empty-row"><td colspan="4">Couldn\'t load rankings. Refresh to try again.</td></tr>';
    el('playersTableBody').innerHTML = errorRow;
    el('decksTableBody').innerHTML = errorRow;
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
  initDeckPreview();
  initAccount();
  initRankingTabs();
  initChat();
  initLog();
  initTurnTimer();
  renderFactionThumbnails();
  FACTION_KEYS.forEach(renderDeckBadgeRow);
  loadRankings();
})();
