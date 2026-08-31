import beast from '../../public/data/beast.json';
import clock from '../../public/data/clock.json';
import damned from '../../public/data/damned.json';
import dwarf from '../../public/data/dwarf.json';
import dynasty from '../../public/data/dynasty.json';
import elf from '../../public/data/elf.json';
import fallen from '../../public/data/fallen.json';
import human from '../../public/data/human.json';
import orc from '../../public/data/orc.json';
import undead from '../../public/data/undead.json';

export const FACTIONS = { beast, clock, damned, dwarf, dynasty, elf, fallen, human, orc, undead };
export const LANES = 5;
export const STARTING_HP = 30;
export const MAX_MANA = 10;
export const STARTING_HAND_SIZE = 5;

// Cards are written against a small shared keyword vocabulary. Everything is
// detected from the printed text (including any numeric magnitude) rather
// than hand-tagged per card, so the ~260-card set stays consistent and any
// future card just needs the right words in its text to work.
function detectKeywords(text) {
  const t = (text || '').toLowerCase();
  const kw = [];
  if (/volley|ranged/.test(t)) kw.push('volley');
  if (/phalanx|shield-wall|shield wall|stalwart/.test(t)) kw.push('phalanx');
  if (/siege|building/.test(t)) kw.push('siege');
  if (/trample|cleave/.test(t)) kw.push('trample');
  if (/charge/.test(t)) kw.push('charge');
  if (/guard/.test(t)) kw.push('guard');
  if (/precise|ignores? guard/.test(t)) kw.push('precise');
  if (/mend/.test(t)) kw.push('mend');
  if (/rage/.test(t)) kw.push('rage');
  if (/rebirth/.test(t)) kw.push('rebirth');
  if (/formation/.test(t)) kw.push('formation');
  if (/countdown/.test(t)) kw.push('countdown');
  if (/salvage/.test(t)) kw.push('salvage');
  if (/reap/.test(t)) kw.push('reap');
  if (/bloodprice/.test(t)) kw.push('bloodprice');
  if (/last breath/.test(t)) kw.push('lastbreath');
  if (/fortify|resolve/.test(t)) kw.push('fortify');
  if (/pack hunt/.test(t)) kw.push('packhunt');
  return kw;
}

function firstNumber(text, fallback) {
  const m = (text || '').match(/\d+/);
  return m ? parseInt(m[0], 10) : fallback;
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

// Each deck is simply its faction's 26 unique cards, one copy each, shuffled.
export function buildDeck(factionKey) {
  const faction = FACTIONS[factionKey];
  if (!faction) throw new Error('Unknown faction: ' + factionKey);
  const deck = faction.cards.map(makeCardInstance);
  return shuffle(deck);
}

function makeCardInstance(card) {
  return {
    instanceId: nextInstanceId(),
    cardId: card.id,
    name: card.name,
    type: card.type || 'unit',
    cost: card.cost,
    power: card.power,
    basePower: card.power,
    defense: card.defense,
    maxDefense: card.defense,
    text: card.text,
    image: card.image,
    keywords: detectKeywords(card.text),
    faction: card.id.split('_')[0],
    usedRebirth: false,
    usedRage: false,
    countdown: /countdown/i.test(card.text || '') ? firstNumber(card.text, 1) : null,
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
      graveyard: [],
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
      graveyard: [],
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
  if (player.deck.length === 0) return false;
  player.hand.push(player.deck.shift());
  return true;
}

function allUnits(player) {
  return [...player.board.vanguard, ...player.board.rearguard].filter(Boolean);
}

// Formation is never stored — it's recomputed from the live board every time
// a unit's power/toughness matters, so moving/destroying neighbors updates
// it automatically without needing to track buffs separately.
function isFormationActive(game, owner, lane, slotIndex) {
  const unit = game.players[owner].board[lane][slotIndex];
  if (!unit || !unit.keywords.includes('formation')) return false;
  const row = game.players[owner].board[lane];
  const left = slotIndex > 0 ? row[slotIndex - 1] : null;
  const right = slotIndex < LANES - 1 ? row[slotIndex + 1] : null;
  return [left, right].some((n) => n && n.faction === unit.faction);
}

function effectivePower(game, owner, lane, slotIndex) {
  const unit = game.players[owner].board[lane][slotIndex];
  if (!unit) return 0;
  let power = unit.power;
  if (isFormationActive(game, owner, lane, slotIndex)) power += 1;
  if (unit.keywords.includes('packhunt')) {
    power += allUnits(game.players[owner]).filter((u) => u.instanceId !== unit.instanceId && u.faction === unit.faction).length;
  }
  return power;
}

// Only cards whose text explicitly promises HP too (Samurai: "+1 DMG and +1
// HP") get tankier while formed up — Dynasty's plain default only promises
// DMG, so it correctly gets nothing extra here.
function hasFormationToughness(game, owner, lane, slotIndex) {
  const unit = game.players[owner].board[lane][slotIndex];
  if (!unit || !/\+1 hp/i.test(unit.text || '')) return false;
  return isFormationActive(game, owner, lane, slotIndex);
}

function findLaneOf(player, instanceId) {
  for (const lane of ['vanguard', 'rearguard']) {
    const idx = player.board[lane].findIndex((u) => u && u.instanceId === instanceId);
    if (idx !== -1) return { lane, idx };
  }
  return null;
}

function mostDamagedAlly(player) {
  const units = allUnits(player).filter((u) => u.defense < u.maxDefense);
  if (units.length === 0) return null;
  units.sort((a, b) => a.defense / a.maxDefense - b.defense / b.maxDefense);
  return units[0];
}

// Runs whenever any unit is destroyed: Salvage draws for its own controller,
// Reap draws for whoever is NOT the destroyed unit's controller.
function onUnitDestroyed(game, ownerOfDead) {
  const dead = game.players[ownerOfDead];
  const alive = game.players[opponentOf(ownerOfDead)];
  if (allUnits(dead).some((u) => u.keywords.includes('salvage'))) {
    if (draw(dead)) game.log.push(`${ownerOfDead} draws a card (Salvage).`);
  }
  if (allUnits(alive).some((u) => u.keywords.includes('reap'))) {
    if (draw(alive)) game.log.push(`${opponentOf(ownerOfDead)} draws a card (Reap).`);
  }
}

function destroyUnit(game, owner, lane, slotIndex) {
  const player = game.players[owner];
  const unit = player.board[lane][slotIndex];
  if (!unit) return;
  if (unit.keywords.includes('rebirth') && !unit.usedRebirth) {
    unit.usedRebirth = true;
    unit.defense = 1;
    unit.power = unit.basePower;
    player.board[lane][slotIndex] = null;
    player.hand.push(unit);
    game.log.push(`${unit.name} returns to ${owner}'s hand at 1 HP (Rebirth).`);
    return;
  }
  player.board[lane][slotIndex] = null;
  player.graveyard.push(unit);
  game.log.push(`${unit.name} is destroyed.`);
  if (unit.keywords.includes('lastbreath')) {
    // Scope the number to the clause after "Last Breath" specifically —
    // compound card text (e.g. "Bloodprice 2: ... Last Breath: Draw 2
    // cards.") has more than one number in it.
    const n = firstNumber(unit.text.split(/last breath/i)[1] || '', 1);
    for (let i = 0; i < n; i++) draw(player);
    game.log.push(`${owner} draws ${n} card(s) (Last Breath).`);
  }
  onUnitDestroyed(game, owner);
}

export function startTurn(game, owner) {
  const player = game.players[owner];
  player.maxMana = Math.min(MAX_MANA, player.maxMana + 1);
  player.mana = player.maxMana;
  const drew = draw(player);
  for (const lane of ['vanguard', 'rearguard']) {
    player.board[lane].forEach((unit, idx) => {
      if (!unit) return;
      unit.sick = false;
      unit.attackedThisTurn = false;
      if (unit.countdown !== null) {
        unit.countdown -= 1;
        if (unit.countdown <= 0) {
          resolveCountdown(game, owner, lane, idx);
          unit.countdown = null;
        }
      }
    });
  }
  game.turn = owner;
  game.phase = 'deployment';
  if (!drew) {
    game.winner = opponentOf(owner);
    game.phase = 'gameover';
    game.log.push(`${owner}'s deck is empty — ${owner} decks out and loses!`);
  }
}

function resolveCountdown(game, owner, lane, slotIndex) {
  const unit = game.players[owner].board[lane][slotIndex];
  if (!unit) return;
  const opponent = game.players[opponentOf(owner)];
  const dmg = firstNumber(unit.text.split(/deal/i)[1] || '', 1);
  const targets = allUnits(opponent);
  if (targets.length > 0) {
    const target = targets[Math.floor(Math.random() * targets.length)];
    const loc = findLaneOf(opponent, target.instanceId);
    target.defense -= dmg;
    game.log.push(`${unit.name}'s Countdown deals ${dmg} to ${target.name}.`);
    if (target.defense <= 0) destroyUnit(game, opponentOf(owner), loc.lane, loc.idx);
  } else {
    opponent.hp -= dmg;
    game.log.push(`${unit.name}'s Countdown deals ${dmg} to the enemy Commander.`);
  }
  if (/draw a card/i.test(unit.text)) {
    draw(game.players[owner]);
    game.log.push(`${owner} draws a card (Countdown).`);
  }
  checkWinner(game);
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

  if (unit.keywords.includes('mend')) {
    const target = mostDamagedAlly(player);
    if (target) {
      const n = firstNumber(unit.text, 2);
      target.defense = Math.min(target.maxDefense, target.defense + n);
      game.log.push(`${unit.name} mends ${target.name} for ${n}.`);
    }
  }
  if (unit.keywords.includes('bloodprice')) {
    // Scope to the "Bloodprice"/"deal ... to your own Commander" clause so a
    // compound card (e.g. "Bloodprice 2: ... Last Breath: Draw 2 cards.")
    // doesn't accidentally pick up a number from its other clause.
    const clause = unit.text.match(/bloodprice\s*(\d+)/i) || unit.text.match(/deal (\d+) dmg to (?:your own|its own) commander/i);
    const n = clause ? parseInt(clause[1], 10) : 1;
    player.hp -= n;
    game.log.push(`${unit.name}'s Bloodprice deals ${n} to ${owner}'s own Commander.`);
    if (/draw a card/i.test(unit.text)) {
      draw(player);
      game.log.push(`${owner} draws a card (Bloodprice).`);
    }
    checkWinner(game);
  }

  return unit;
}

export function moveToCombat(game, owner) {
  requireActive(game, owner);
  if (game.phase !== 'deployment') throw new Error('Already past the Deployment phase.');
  game.phase = 'combat';
}

// Guard forces attackers to target it first, from either row — a change
// from only-Vanguard-blocks, since these individual character cards carry
// Guard as a property of the card rather than of the row it's standing in.
// Volley/Ranged units ignore Guard entirely (their own printed text says so).
export function getLegalTargetLanes(game, owner, attackerLane, attackerSlot) {
  const player = game.players[owner];
  const unit = player.board[attackerLane][attackerSlot];
  if (!unit) return [];
  if (unit.keywords.includes('siege')) return ['commander'];
  const oppBoard = game.players[opponentOf(owner)].board;
  const vanguard = oppBoard.vanguard[attackerSlot];
  const rearguard = oppBoard.rearguard[attackerSlot];
  const hasVolley = unit.keywords.includes('volley');
  const hasPrecise = unit.keywords.includes('precise');

  if (hasVolley) {
    // Volley/Ranged ignores Guard and forced blocking entirely — it may
    // choose either occupied row, or the Commander if the lane is empty.
    const opts = [];
    if (vanguard) opts.push('vanguard');
    if (rearguard) opts.push('rearguard');
    if (opts.length === 0) opts.push('commander');
    return opts;
  }
  // Precise only ignores a Guard blocker specifically — an ordinary occupied
  // Vanguard still stops it like anyone else.
  if (vanguard) return ['vanguard'];
  if (rearguard && rearguard.keywords.includes('guard') && !hasPrecise) return ['rearguard'];
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
  const attackPower = effectivePower(game, owner, attackerLane, attackerSlot);

  if (targetLane === 'commander') {
    opponent.hp -= attackPower;
    game.log.push(`${owner}'s ${unit.name} hits the enemy Commander for ${attackPower}.`);
    checkWinner(game);
    return game;
  }

  const targetUnit = opponent.board[targetLane][attackerSlot];
  let dmg = attackPower;
  if (targetUnit.keywords.includes('phalanx')) dmg = Math.max(0, dmg - 1);
  if (hasFormationToughness(game, opponentOf(owner), targetLane, attackerSlot)) dmg = Math.max(0, dmg - 1);
  targetUnit.defense -= dmg;
  game.log.push(`${owner}'s ${unit.name} hits ${targetUnit.name} for ${dmg}.`);

  const survived = targetUnit.defense > 0;
  // Rage is repeatable ("whenever") unless the card's own text says "first
  // time" (the Orc faction default is the one-time, weaker variant).
  if (survived && targetUnit.keywords.includes('rage')) {
    const onceOnly = /first time/i.test(targetUnit.text);
    if (!onceOnly || !targetUnit.usedRage) {
      const n = firstNumber(targetUnit.text, 1);
      targetUnit.power += n;
      targetUnit.basePower += n;
      targetUnit.usedRage = true;
      game.log.push(`${targetUnit.name} enters a Rage, permanently gaining +${n} DMG.`);
    }
  }
  if (survived && targetUnit.keywords.includes('fortify')) {
    targetUnit.maxDefense += 1;
    targetUnit.defense += 1;
    game.log.push(`${targetUnit.name} is Fortified, gaining +1 HP.`);
  }

  if (!survived) {
    const overflow = -targetUnit.defense;
    destroyUnit(game, opponentOf(owner), targetLane, attackerSlot);
    if (unit.keywords.includes('trample') && overflow > 0) {
      const behind = targetLane === 'vanguard' ? opponent.board.rearguard[attackerSlot] : null;
      if (behind) {
        behind.defense -= overflow;
        game.log.push(`Trample carries ${overflow} to ${behind.name}.`);
        if (behind.defense <= 0) destroyUnit(game, opponentOf(owner), 'rearguard', attackerSlot);
      } else {
        opponent.hp -= overflow;
        game.log.push(`Trample carries ${overflow} to the enemy Commander.`);
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
      deckCount: game.players[opp].deck.length,
    },
    turn: game.turn,
    phase: game.phase,
    turnNumber: game.turnNumber,
    winner: game.winner,
    log: game.log.slice(-30),
    you_key: owner,
  };
}
