import human from '../../public/data/human.json';
import elf from '../../public/data/elf.json';
import dwarf from '../../public/data/dwarf.json';
import orc from '../../public/data/orc.json';

export const FACTIONS = { human, elf, dwarf, orc };
export const LANES = 5;
export const STARTING_HP = 30;
export const MAX_MANA = 10;
export const STARTING_HAND_SIZE = 5;

function detectKeywords(text) {
  const t = (text || '').toLowerCase();
  const kw = [];
  if (/volley|ranged/.test(t)) kw.push('volley');
  if (/phalanx|shield-wall|shield wall/.test(t)) kw.push('phalanx');
  if (/siege|building/.test(t)) kw.push('siege');
  if (/trample|cleave/.test(t)) kw.push('trample');
  if (/charge/.test(t)) kw.push('charge');
  return kw;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

let instanceCounter = 0;
function nextInstanceId() {
  instanceCounter += 1;
  return `inst_${Date.now().toString(36)}_${instanceCounter}`;
}

export function buildDeck(factionKey) {
  const faction = FACTIONS[factionKey];
  if (!faction) throw new Error('Unknown faction: ' + factionKey);
  const deck = [];
  for (const card of faction.cards) {
    const copies = card.unique ? 1 : 3;
    for (let i = 0; i < copies; i++) {
      deck.push(makeCardInstance(card));
    }
  }
  return shuffle(deck);
}

function makeCardInstance(card) {
  return {
    instanceId: nextInstanceId(),
    cardId: card.id,
    name: card.name,
    cost: card.cost,
    power: card.power,
    defense: card.defense,
    maxDefense: card.defense,
    text: card.text,
    unique: !!card.unique,
    keywords: detectKeywords(card.text),
  };
}

function emptyBoard() {
  return { vanguard: new Array(LANES).fill(null), rearguard: new Array(LANES).fill(null) };
}

export function opponentOf(owner) {
  return owner === 'A' ? 'B' : 'A';
}

export function createGame(factionA, factionB) {
  const deckA = buildDeck(factionA);
  const deckB = buildDeck(factionB);
  const players = {
    A: {
      faction: factionA,
      deck: deckA,
      hand: deckA.splice(0, STARTING_HAND_SIZE),
      board: emptyBoard(),
      hp: STARTING_HP,
      maxMana: 1,
      mana: 1,
      connected: false,
    },
    B: {
      faction: factionB,
      deck: deckB,
      hand: deckB.splice(0, STARTING_HAND_SIZE),
      board: emptyBoard(),
      hp: STARTING_HP,
      maxMana: 1,
      mana: 1,
      connected: false,
    },
  };
  return {
    players,
    turn: 'A',
    phase: 'deployment',
    turnNumber: 1,
    winner: null,
    log: ['Match started. Player A goes first.'],
  };
}

function draw(player) {
  if (player.deck.length === 0) return;
  player.hand.push(player.deck.shift());
}

export function startTurn(game, owner) {
  const player = game.players[owner];
  player.maxMana = Math.min(MAX_MANA, player.maxMana + 1);
  player.mana = player.maxMana;
  draw(player);
  for (const lane of ['vanguard', 'rearguard']) {
    for (const unit of player.board[lane]) {
      if (unit) {
        unit.sick = false;
        unit.attackedThisTurn = false;
      }
    }
  }
  game.turn = owner;
  game.phase = 'deployment';
}

export function playCard(game, owner, cardInstanceId, lane, slotIndex) {
  requireActive(game, owner);
  if (game.phase !== 'deployment') throw new Error('Cards can only be played during the Deployment phase.');
  if (lane !== 'vanguard' && lane !== 'rearguard') throw new Error('Invalid lane.');
  if (slotIndex < 0 || slotIndex >= LANES) throw new Error('Invalid slot.');
  const player = game.players[owner];
  if (player.board[lane][slotIndex]) throw new Error('That slot is already occupied.');
  const idx = player.hand.findIndex((c) => c.instanceId === cardInstanceId);
  if (idx === -1) throw new Error('Card not in hand.');
  const card = player.hand[idx];
  if (card.cost > player.mana) throw new Error('Not enough mana.');
  player.hand.splice(idx, 1);
  player.mana -= card.cost;
  const unit = { ...card, sick: !card.keywords.includes('charge'), attackedThisTurn: false };
  player.board[lane][slotIndex] = unit;
  game.log.push(`${owner} played ${card.name} to ${lane} ${slotIndex + 1}.`);
  return unit;
}

export function moveToCombat(game, owner) {
  requireActive(game, owner);
  if (game.phase !== 'deployment') throw new Error('Already past the Deployment phase.');
  game.phase = 'combat';
}

export function getLegalTargetLanes(game, owner, attackerLane, attackerSlot) {
  const player = game.players[owner];
  const unit = player.board[attackerLane][attackerSlot];
  if (!unit) return [];
  if (unit.keywords.includes('siege')) return ['commander'];
  const oppBoard = game.players[opponentOf(owner)].board;
  const vanguardOccupied = !!oppBoard.vanguard[attackerSlot];
  const rearguardOccupied = !!oppBoard.rearguard[attackerSlot];
  const hasVolley = unit.keywords.includes('volley');
  if (vanguardOccupied) {
    if (hasVolley) return rearguardOccupied ? ['vanguard', 'rearguard'] : ['vanguard'];
    return ['vanguard'];
  }
  if (rearguardOccupied) return ['rearguard'];
  return ['commander'];
}

export function attack(game, owner, attackerLane, attackerSlot, targetLane) {
  requireActive(game, owner);
  if (game.phase !== 'combat') throw new Error('Attacks can only happen during the Combat phase.');
  const player = game.players[owner];
  const unit = player.board[attackerLane][attackerSlot];
  if (!unit) throw new Error('No unit in that slot.');
  if (unit.sick) throw new Error('That unit has summoning sickness.');
  if (unit.attackedThisTurn) throw new Error('That unit already attacked this turn.');
  const legal = getLegalTargetLanes(game, owner, attackerLane, attackerSlot);
  if (!legal.includes(targetLane)) throw new Error('Illegal target for this attack.');

  const opponent = game.players[opponentOf(owner)];
  unit.attackedThisTurn = true;

  if (targetLane === 'commander') {
    opponent.hp -= unit.power;
    game.log.push(`${owner}'s ${unit.name} hits the enemy Commander for ${unit.power}.`);
  } else {
    const targetUnit = opponent.board[targetLane][attackerSlot];
    let dmg = unit.power;
    if (targetUnit.keywords.includes('phalanx')) dmg = Math.max(0, dmg - 1);
    targetUnit.defense -= dmg;
    game.log.push(`${owner}'s ${unit.name} hits ${targetUnit.name} for ${dmg}.`);
    if (targetUnit.defense <= 0) {
      const overflow = -targetUnit.defense;
      opponent.board[targetLane][attackerSlot] = null;
      game.log.push(`${targetUnit.name} is destroyed.`);
      if (unit.keywords.includes('trample') && overflow > 0) {
        if (targetLane === 'vanguard' && opponent.board.rearguard[attackerSlot]) {
          const behind = opponent.board.rearguard[attackerSlot];
          behind.defense -= overflow;
          game.log.push(`Trample carries ${overflow} to ${behind.name}.`);
          if (behind.defense <= 0) {
            opponent.board.rearguard[attackerSlot] = null;
            game.log.push(`${behind.name} is destroyed.`);
          }
        } else {
          opponent.hp -= overflow;
          game.log.push(`Trample carries ${overflow} to the enemy Commander.`);
        }
      }
    }
  }

  checkWinner(game);
  return game;
}

export function endTurn(game, owner) {
  requireActive(game, owner);
  game.phase = 'end';
  const next = opponentOf(owner);
  game.turnNumber += 1;
  startTurn(game, next);
}

function checkWinner(game) {
  if (game.players.A.hp <= 0) game.winner = 'B';
  if (game.players.B.hp <= 0) game.winner = 'A';
  if (game.winner) game.phase = 'gameover';
}

function requireActive(game, owner) {
  if (game.winner) throw new Error('The game is already over.');
  if (game.turn !== owner) throw new Error("It's not your turn.");
}

export function viewFor(game, owner) {
  const opp = opponentOf(owner);
  return {
    you: game.players[owner],
    opponent: {
      ...game.players[opp],
      hand: game.players[opp].hand.map(() => ({ hidden: true })),
      deck: undefined,
    },
    turn: game.turn,
    phase: game.phase,
    turnNumber: game.turnNumber,
    winner: game.winner,
    log: game.log.slice(-30),
    you_key: owner,
  };
}
