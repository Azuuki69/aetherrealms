const FACTION_KEYS = ['human', 'elf', 'dwarf', 'orc'];
const cardIndex = {}; // cardId -> { faction, sheet, sheetSize, rect, ...cardDef }
const factionData = {};

async function loadFactionData() {
  await Promise.all(
    FACTION_KEYS.map(async (key) => {
      const res = await fetch(`data/${key}.json`);
      const data = await res.json();
      factionData[key] = data;
      for (const card of data.cards) {
        cardIndex[card.id] = { faction: key, sheet: data.sheet, sheetSize: data.sheetSize, ...card };
      }
    })
  );
}

// ---------- Lobby state ----------
let selectedFaction = null;
let ws = null;
let mySeatKey = null; // 'A' or 'B', informational only
let currentView = null;
let selectedHandCardId = null;
let selectedAttacker = null; // { lane, slot }
let tutorialDismissed = false;

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
      ws.send(JSON.stringify({ type: 'join', faction: selectedFaction }));
      break;
    case 'waiting_for_opponent':
      setStatus('Waiting for opponent to join...');
      break;
    case 'state':
      showGame();
      currentView = msg;
      mySeatKey = msg.you_key;
      selectedHandCardId = null;
      selectedAttacker = null;
      render();
      break;
    case 'opponent_disconnected':
      logLine('Opponent disconnected. They can rejoin with the same room code.');
      break;
    case 'opponent_reconnected':
      logLine('Opponent reconnected.');
      break;
    case 'error':
      logLine('Error: ' + msg.message);
      break;
  }
}

function showGame() {
  el('lobby').classList.add('hidden');
  el('game').classList.remove('hidden');
}

// ---------- Rendering ----------
function cardArtStyle(cardId, displayW) {
  const def = cardIndex[cardId];
  if (!def) return {};
  const scale = displayW / def.rect.w;
  return {
    sheet: def.sheet,
    width: def.sheetSize.w * scale,
    height: def.sheetSize.h * scale,
    left: -def.rect.x * scale,
    top: -def.rect.y * scale,
  };
}

function buildCardEl(instance, { faceDown = false, context = 'board' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'card' + (context === 'hand' ? ' hand-card' : '');
  if (faceDown || !instance || instance.hidden) {
    wrap.style.background = '#2a2015';
    wrap.style.border = '2px solid #5c4419';
    return wrap;
  }

  const style = cardArtStyle(instance.cardId, 100);
  if (style.sheet) {
    const img = document.createElement('img');
    img.className = 'art';
    img.src = style.sheet;
    img.style.width = style.width + 'px';
    img.style.height = style.height + 'px';
    img.style.left = style.left + 'px';
    img.style.top = style.top + 'px';
    wrap.appendChild(img);
  }

  const cost = document.createElement('div');
  cost.className = 'badge cost';
  cost.textContent = instance.cost;
  wrap.appendChild(cost);

  const power = document.createElement('div');
  power.className = 'badge power';
  power.textContent = instance.power;
  wrap.appendChild(power);

  const defense = document.createElement('div');
  defense.className = 'badge defense';
  defense.textContent = instance.defense;
  wrap.appendChild(defense);

  if (instance.keywords && instance.keywords.length) {
    const kw = document.createElement('div');
    kw.className = 'keyword-tag';
    kw.textContent = instance.keywords[0];
    wrap.appendChild(kw);
  }

  wrap.title = `${instance.name}\n${instance.text || ''}`;

  if (instance.sick) wrap.classList.add('sick');
  if (instance.attackedThisTurn) wrap.classList.add('attacked');

  if (context === 'hand') {
    wrap.addEventListener('mouseenter', (e) => showPreview(instance, e));
    wrap.addEventListener('mousemove', (e) => movePreview(e));
    wrap.addEventListener('mouseleave', hidePreview);
  }

  return wrap;
}

function showPreview(instance, evt) {
  const style = cardArtStyle(instance.cardId, 220);
  if (!style.sheet) return;
  const img = el('previewImg');
  img.src = style.sheet;
  img.style.width = style.width + 'px';
  img.style.height = style.height + 'px';
  img.style.left = style.left + 'px';
  img.style.top = style.top + 'px';
  el('previewCost').textContent = instance.cost;
  el('previewPower').textContent = instance.power;
  el('previewDefense').textContent = instance.defense;
  el('previewName').textContent = instance.name;
  el('previewText').textContent = instance.text || '';
  el('cardPreview').classList.add('visible');
  movePreview(evt);
}

function movePreview(evt) {
  const preview = el('cardPreview');
  const margin = 16;
  const pw = preview.offsetWidth || 220;
  const ph = preview.offsetHeight || 360;
  let x = evt.clientX - pw / 2;
  let y = evt.clientY - ph - margin;
  x = Math.max(margin, Math.min(window.innerWidth - pw - margin, x));
  if (y < margin) y = evt.clientY + margin;
  preview.style.left = x + 'px';
  preview.style.top = y + 'px';
}

function hidePreview() {
  el('cardPreview').classList.remove('visible');
}

function render() {
  if (!currentView) return;
  const { you, opponent, turn, phase, turnNumber, winner, log, you_key } = currentView;
  const myTurn = turn === you_key;

  el('youInfo').querySelector('.name').textContent = `You (${capitalize(you.faction)})`;
  el('youInfo').querySelector('.hp-fill').style.width = Math.max(0, (you.hp / 30) * 100) + '%';
  el('youInfo').querySelector('.mana').textContent = `${you.mana}/${you.maxMana} mana`;

  el('oppInfo').querySelector('.name').textContent = `Opponent (${capitalize(opponent.faction)})`;
  el('oppInfo').querySelector('.hp-fill').style.width = Math.max(0, (opponent.hp / 30) * 100) + '%';
  el('oppInfo').querySelector('.mana').textContent = `${opponent.mana}/${opponent.maxMana} mana`;

  el('turnIndicator').textContent = winner
    ? 'Game Over'
    : `Turn ${turnNumber} — ${myTurn ? 'Your' : "Opponent's"} turn (${phase})`;

  renderLane('youVanguard', you.board.vanguard, 'you', 'vanguard');
  renderLane('youRearguard', you.board.rearguard, 'you', 'rearguard');
  renderLane('oppVanguard', opponent.board.vanguard, 'opp', 'vanguard');
  renderLane('oppRearguard', opponent.board.rearguard, 'opp', 'rearguard');

  renderHand(you.hand, myTurn && phase === 'deployment');

  el('combatBtn').disabled = !(myTurn && phase === 'deployment');
  el('endTurnBtn').disabled = !(myTurn && (phase === 'combat' || phase === 'deployment'));

  el('log').innerHTML = '';
  for (const line of log) {
    const d = document.createElement('div');
    d.textContent = line;
    el('log').appendChild(d);
  }
  el('log').scrollTop = el('log').scrollHeight;

  highlightSelections();
  renderTutorial(turnNumber);

  if (winner) {
    el('gameOverOverlay').classList.remove('hidden');
    el('gameOverText').textContent = winner === you_key ? 'Victory!' : 'Defeat...';
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
  selectedAttacker = null;
  selectedHandCardId = selectedHandCardId === card.instanceId ? null : card.instanceId;
  render();
}

function onEmptySlotClick(side, lane, slotIndex) {
  if (side !== 'you' || !selectedHandCardId) return;
  send({ type: 'play_card', cardInstanceId: selectedHandCardId, lane, slotIndex });
}

function onBoardCardClick(side, lane, slotIndex) {
  const { you, turn, phase, you_key } = currentView;
  const myTurn = turn === you_key;

  if (side === 'you') {
    if (!myTurn || phase !== 'combat') return;
    const unit = you.board[lane][slotIndex];
    if (!unit || unit.sick || unit.attackedThisTurn) return;
    selectedHandCardId = null;
    selectedAttacker =
      selectedAttacker && selectedAttacker.lane === lane && selectedAttacker.slot === slotIndex
        ? null
        : { lane, slot: slotIndex };
    render();
  } else {
    if (!selectedAttacker) return;
    if (slotIndex !== selectedAttacker.slot) return;
    send({
      type: 'attack',
      attackerLane: selectedAttacker.lane,
      attackerSlot: selectedAttacker.slot,
      targetLane: lane,
    });
  }
}

function legalTargetLanes(attacker) {
  const { you, opponent } = currentView;
  const unit = you.board[attacker.lane][attacker.slot];
  if (!unit) return [];
  if (unit.keywords.includes('siege')) return ['commander'];
  const col = attacker.slot;
  const vanguardOccupied = !!opponent.board.vanguard[col];
  const rearguardOccupied = !!opponent.board.rearguard[col];
  const hasVolley = unit.keywords.includes('volley');
  if (vanguardOccupied) {
    if (hasVolley) return rearguardOccupied ? ['vanguard', 'rearguard'] : ['vanguard'];
    return ['vanguard'];
  }
  if (rearguardOccupied) return ['rearguard'];
  return ['commander'];
}

function highlightSelections() {
  document.querySelectorAll('.slot').forEach((s) => s.classList.remove('can-play', 'legal-target'));
  el('oppInfo').classList.remove('legal-target');

  if (selectedHandCardId) {
    document.querySelectorAll('#youVanguard .slot, #youRearguard .slot').forEach((s) => {
      if (s.children.length === 0) s.classList.add('can-play');
    });
  }

  if (selectedAttacker) {
    const legal = legalTargetLanes(selectedAttacker);
    for (const laneName of legal) {
      if (laneName === 'commander') {
        el('oppInfo').classList.add('legal-target');
      } else {
        const containerId = laneName === 'vanguard' ? 'oppVanguard' : 'oppRearguard';
        const slot = document.querySelectorAll(`#${containerId} .slot`)[selectedAttacker.slot];
        if (slot) slot.classList.add('legal-target');
      }
    }
  }
}

el('oppInfo')?.addEventListener('click', () => {
  if (!selectedAttacker) return;
  const legal = legalTargetLanes(selectedAttacker);
  if (!legal.includes('commander')) return;
  send({
    type: 'attack',
    attackerLane: selectedAttacker.lane,
    attackerSlot: selectedAttacker.slot,
    targetLane: 'commander',
  });
});

el('combatBtn')?.addEventListener('click', () => send({ type: 'move_to_combat' }));
el('endTurnBtn')?.addEventListener('click', () => {
  selectedHandCardId = null;
  selectedAttacker = null;
  send({ type: 'end_turn' });
});

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function logLine(text) {
  const d = document.createElement('div');
  d.textContent = text;
  el('log').appendChild(d);
  el('log').scrollTop = el('log').scrollHeight;
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const TUTORIAL_TIP_IDS = ['tipHand', 'tipCombat', 'tipCommander'];

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

(async function init() {
  await loadFactionData();
  initLobby();
  initTutorial();
})();
