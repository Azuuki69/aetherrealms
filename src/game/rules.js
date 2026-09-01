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
export const LANES = 7;
export const STARTING_HP = 50;
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
  // A card whose only mention of "guard" is "ignores Guard" (Precise's own
  // wording) must not also become a real Guard blocker itself.
  if (/guard/.test(t) && !/ignores? guard/.test(t)) kw.push('guard');
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
  if (/shield/.test(t)) kw.push('shield');
  if (/lifesteal/.test(t)) kw.push('lifesteal');
  if (/venom/.test(t)) kw.push('venom');
  if (/rally/.test(t)) kw.push('rally');
  if (/growing/.test(t)) kw.push('growing');
  if (/cull/.test(t)) kw.push('cull');
  if (/vigil/.test(t)) kw.push('vigil');
  if (/parting gift/.test(t)) kw.push('partinggift');
  if (/desperate/.test(t)) kw.push('desperate');
  if (/hoarder/.test(t)) kw.push('hoarder');
  if (/war cry/.test(t)) kw.push('warcry');
  if (/slayer/.test(t)) kw.push('slayer');
  if (/curse/.test(t)) kw.push('curse');
  if (/taunt/.test(t)) kw.push('taunt');
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

// Each faction's 10 hand-tuned flagship cards stay singleton regardless of
// cost (a real deck's "legendary" tier); every other card gets 2 copies if
// cheap enough (cost <= 3) to behave like a real constructed deck's commons.
const FLAGSHIP_NAMES = new Set([
  'Dire Wolf', 'Sparkwright', 'The Creditor', 'Warden', 'Samurai',
  'Sharpshooter', 'Scavenger-Lord', 'Paladin', 'Berserker', 'Lich',
]);

export function buildDeck(factionKey) {
  const faction = FACTIONS[factionKey];
  if (!faction) throw new Error('Unknown faction: ' + factionKey);
  const deck = [];
  for (const card of faction.cards) {
    const copies = !FLAGSHIP_NAMES.has(card.name) && card.cost <= 3 ? 2 : 1;
    for (let i = 0; i < copies; i++) deck.push(makeCardInstance(card));
  }
  return shuffle(deck);
}

function makeCardInstance(card) {
  const keywords = detectKeywords(card.text);
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
    keywords,
    hasShield: keywords.includes('shield'),
    faction: card.id.split('_')[0],
    usedRebirth: false,
    usedRage: false,
    tempPowerBonus: 0,
    countdown: /countdown/i.test(card.text || '') ? firstNumber(card.text, 1) : null,
  };
}

function emptyBoard() {
  return { vanguard: new Array(LANES).fill(null), rearguard: new Array(LANES).fill(null) };
}

export function opponentOf(owner) {
  return owner === 'A' ? 'B' : 'A';
}

export function createGame(factionA, factionB, firstPlayer = 'A') {
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
      maxHp: STARTING_HP,
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
      maxHp: STARTING_HP,
      maxMana: 1,
      mana: 1,
      connected: false,
    },
  };
  return {
    players,
    turn: firstPlayer,
    phase: 'coinflip',
    turnNumber: 1,
    winner: null,
    log: ['Match created — flipping a coin to see who goes first...'],
  };
}

// Falls back to shuffling the graveyard back into the deck once the deck runs
// dry, so a long match never stalls out just because the draw pile emptied —
// only losing when there are truly no cards left anywhere.
function draw(player) {
  if (player.deck.length === 0) {
    if (player.graveyard.length === 0) return false;
    player.deck = shuffle(player.graveyard);
    player.graveyard = [];
  }
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

// Rally is granted OUTWARD to neighbors rather than to the Rally-bearer
// itself — a support unit rather than a self-buffer like Formation. Two
// adjacent Rally units correctly buff each other.
function hasRallyBonus(game, owner, lane, slotIndex) {
  const unit = game.players[owner].board[lane][slotIndex];
  if (!unit) return false;
  const row = game.players[owner].board[lane];
  const left = slotIndex > 0 ? row[slotIndex - 1] : null;
  const right = slotIndex < LANES - 1 ? row[slotIndex + 1] : null;
  return [left, right].some((n) => n && n.faction === unit.faction && n.keywords.includes('rally'));
}

function effectivePower(game, owner, lane, slotIndex) {
  const unit = game.players[owner].board[lane][slotIndex];
  if (!unit) return 0;
  const player = game.players[owner];
  let power = unit.power;
  if (isFormationActive(game, owner, lane, slotIndex)) power += 1;
  if (hasRallyBonus(game, owner, lane, slotIndex)) power += 1;
  if (unit.keywords.includes('packhunt')) {
    power += allUnits(player).filter((u) => u.instanceId !== unit.instanceId && u.faction === unit.faction).length;
  }
  if (unit.keywords.includes('desperate') && player.hp < player.maxHp / 2) power += 2;
  if (unit.keywords.includes('hoarder')) power += Math.min(3, Math.max(0, player.hand.length - 3));
  power += unit.tempPowerBonus || 0;
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
  if (unit.keywords.includes('partinggift')) {
    const enemyPlayer = game.players[opponentOf(owner)];
    const enemyUnits = allUnits(enemyPlayer);
    if (enemyUnits.length > 0) {
      const target = enemyUnits[Math.floor(Math.random() * enemyUnits.length)];
      const loc = findLaneOf(enemyPlayer, target.instanceId);
      target.defense -= 2;
      game.log.push(`${unit.name}'s Parting Gift deals 2 to ${target.name}.`);
      if (target.defense <= 0) destroyUnit(game, opponentOf(owner), loc.lane, loc.idx);
    }
    checkWinner(game);
  }
  onUnitDestroyed(game, owner);
}

export function startTurn(game, owner) {
  const player = game.players[owner];
  player.maxMana = Math.min(MAX_MANA, player.maxMana + 1);
  player.mana = player.maxMana;
  for (const lane of ['vanguard', 'rearguard']) {
    player.board[lane].forEach((unit, idx) => {
      if (!unit) return;
      unit.sick = false;
      unit.attackedThisTurn = false;
      unit.tempPowerBonus = 0;
      if (unit.keywords.includes('vigil')) {
        const before = unit.defense;
        unit.defense = Math.min(unit.maxDefense, unit.defense + 1);
        if (unit.defense > before) game.log.push(`${unit.name} heals 1 HP (Vigil).`);
      }
      if (unit.keywords.includes('growing')) {
        unit.maxDefense += 1;
        unit.defense += 1;
        game.log.push(`${unit.name} grows, gaining +1 HP.`);
      }
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
    game.log.push(`${unit.name}'s Countdown deals ${dmg} to the enemy castle.`);
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
  if (unit.keywords.includes('warcry')) {
    const row = player.board[lane];
    row.forEach((ally) => {
      if (ally && ally.instanceId !== unit.instanceId) {
        ally.tempPowerBonus = (ally.tempPowerBonus || 0) + 1;
      }
    });
    game.log.push(`${unit.name}'s War Cry rallies allies in this row.`);
  }
  if (unit.keywords.includes('cull')) {
    const allies = allUnits(player).filter((u) => u.instanceId !== unit.instanceId);
    if (allies.length > 0) {
      allies.sort((a, b) => a.defense - b.defense);
      const victim = allies[0];
      const victimLoc = findLaneOf(player, victim.instanceId);
      destroyUnit(game, owner, victimLoc.lane, victimLoc.idx);
      const opponentPlayer = game.players[opponentOf(owner)];
      const enemyUnits = allUnits(opponentPlayer);
      if (enemyUnits.length > 0) {
        const target = enemyUnits[Math.floor(Math.random() * enemyUnits.length)];
        const targetLoc = findLaneOf(opponentPlayer, target.instanceId);
        target.defense -= 2;
        game.log.push(`${unit.name}'s Cull sacrifices ${victim.name} to deal 2 to ${target.name}.`);
        if (target.defense <= 0) destroyUnit(game, opponentOf(owner), targetLoc.lane, targetLoc.idx);
      } else {
        opponentPlayer.hp -= 2;
        game.log.push(`${unit.name}'s Cull sacrifices ${victim.name} to deal 2 to the enemy castle.`);
      }
      checkWinner(game);
    }
  }
  if (unit.keywords.includes('bloodprice')) {
    // Scope to the "Bloodprice"/"deal ... to your own Commander" clause so a
    // compound card (e.g. "Bloodprice 2: ... Last Breath: Draw 2 cards.")
    // doesn't accidentally pick up a number from its other clause.
    const clause = unit.text.match(/bloodprice\s*(\d+)/i) || unit.text.match(/deal (\d+) dmg to (?:your own|its own) commander/i);
    const n = clause ? parseInt(clause[1], 10) : 1;
    player.hp -= n;
    game.log.push(`${unit.name}'s Bloodprice deals ${n} to ${owner}'s own castle.`);
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

// A column can route to the castle only when it's genuinely undefended: no
// Vanguard standing in it, and no unbypassed Guard Rearguard forcing itself
// as the mandatory target for that column instead.
function columnOpensCastleRoute(oppBoard, col, hasPrecise) {
  if (oppBoard.vanguard[col]) return false;
  const r = oppBoard.rearguard[col];
  return !(r && r.keywords.includes('guard') && !hasPrecise);
}

// Single source of truth for "can this attacker legally hit this target" —
// used by attack()'s validation, the client's target highlighting, and the
// Attack-All auto-combat loop. Returns a flat list of concrete targets:
// { type: 'unit', lane, slot } or { type: 'castle' }.
//
// Vanguard is always targetable regardless of column (no more same-slot
// lock). A Rearguard is targetable once its OWN column's Vanguard is gone,
// or by a Volley/Ranged attacker regardless. The castle is targetable once
// at least one column is fully undefended. Taunt overrides all of this: any
// reachable Taunt unit becomes the only legal target, including over the
// castle, until no reachable Taunt remains.
export function getLegalAttackTargets(game, owner, attackerLane, attackerSlot) {
  const unit = game.players[owner].board[attackerLane][attackerSlot];
  if (!unit) return [];
  const oppBoard = game.players[opponentOf(owner)].board;
  const isRanged = unit.keywords.includes('volley');
  const hasPrecise = unit.keywords.includes('precise');

  const taunts = [];
  for (const lane of ['vanguard', 'rearguard']) {
    oppBoard[lane].forEach((u, slot) => {
      if (!u || !u.keywords.includes('taunt')) return;
      const reachable = lane === 'vanguard' || isRanged || !oppBoard.vanguard[slot];
      if (reachable) taunts.push({ type: 'unit', lane, slot });
    });
  }
  if (taunts.length > 0) return taunts;

  const targets = [];
  let castleReachable = false;
  for (let col = 0; col < LANES; col++) {
    if (oppBoard.vanguard[col]) targets.push({ type: 'unit', lane: 'vanguard', slot: col });
    if (oppBoard.rearguard[col] && (isRanged || !oppBoard.vanguard[col])) {
      targets.push({ type: 'unit', lane: 'rearguard', slot: col });
    }
    if (columnOpensCastleRoute(oppBoard, col, hasPrecise)) castleReachable = true;
  }
  if (castleReachable) targets.push({ type: 'castle' });
  return targets;
}

// Heals `healOwnerKey`'s castle for `dmgDealt` if `sourceUnit` has Lifesteal.
function applyLifestealIfAny(game, healOwnerKey, sourceUnit, dmgDealt) {
  if (!sourceUnit.keywords.includes('lifesteal') || dmgDealt <= 0) return;
  const player = game.players[healOwnerKey];
  const before = player.hp;
  player.hp = Math.min(player.maxHp, player.hp + dmgDealt);
  if (player.hp > before) game.log.push(`${healOwnerKey} heals ${player.hp - before} (Lifesteal).`);
}

export function attack(game, owner, attackerLane, attackerSlot, targetLane, targetSlot) {
  requireActive(game, owner);
  if (game.phase !== 'combat') throw new Error('Attacks can only happen during the Combat phase.');
  const player = game.players[owner];
  const unit = player.board[attackerLane][attackerSlot];
  if (!unit) throw new Error('No unit in that slot.');
  if (unit.sick) throw new Error('That unit has summoning sickness.');
  if (unit.attackedThisTurn) throw new Error('That unit already attacked this turn.');

  const isCastleTarget = targetLane === 'commander';
  const legal = getLegalAttackTargets(game, owner, attackerLane, attackerSlot);
  const legalMatch = legal.find((t) =>
    isCastleTarget ? t.type === 'castle' : t.type === 'unit' && t.lane === targetLane && t.slot === targetSlot
  );
  if (!legalMatch) throw new Error('Illegal target for this attack.');

  const opponentKey = opponentOf(owner);
  const opponent = game.players[opponentKey];
  unit.attackedThisTurn = true;
  const attackPower = effectivePower(game, owner, attackerLane, attackerSlot);

  // Undefended-column fallthrough: the one way to reach the castle, available
  // to any attacker, not a special ability of any keyword.
  if (isCastleTarget) {
    opponent.hp -= attackPower;
    game.log.push(`${owner}'s ${unit.name} breaks through and hits the enemy castle for ${attackPower}.`);
    applyLifestealIfAny(game, owner, unit, attackPower);
    checkWinner(game);
    return game;
  }

  // Unit vs unit, with symmetric retaliation. Ranged attacks (Volley/Siege)
  // deal damage without risking any back — everything else trades both ways,
  // MTG-style: both hits are computed from pre-combat stats and applied at
  // the same instant, so two units can kill each other in one exchange.
  // NOTE: the attacker and target can now be in different columns, so every
  // lookup into the OPPONENT's board below must use targetSlot, never
  // attackerSlot — only lookups into the ATTACKER's own board stay attackerSlot.
  const targetUnit = opponent.board[targetLane][targetSlot];
  const isRanged = unit.keywords.includes('volley') || unit.keywords.includes('siege');
  const defenderPower = isRanged ? 0 : effectivePower(game, opponentKey, targetLane, targetSlot);

  let fwdShielded = false;
  let backShielded = false;
  if (targetUnit.hasShield) {
    targetUnit.hasShield = false;
    fwdShielded = true;
    game.log.push(`${targetUnit.name}'s Shield absorbs the hit from ${unit.name}.`);
  }
  if (!isRanged && unit.hasShield) {
    unit.hasShield = false;
    backShielded = true;
    game.log.push(`${unit.name}'s Shield absorbs the retaliation from ${targetUnit.name}.`);
  }

  let fwdDmg = 0;
  if (!fwdShielded) {
    fwdDmg = attackPower;
    if (targetUnit.keywords.includes('phalanx')) fwdDmg = Math.max(0, fwdDmg - 1);
    if (hasFormationToughness(game, opponentKey, targetLane, targetSlot)) fwdDmg = Math.max(0, fwdDmg - 1);
  }
  let backDmg = 0;
  if (!isRanged && !backShielded) {
    backDmg = defenderPower;
    if (unit.keywords.includes('phalanx')) backDmg = Math.max(0, backDmg - 1);
    if (hasFormationToughness(game, owner, attackerLane, attackerSlot)) backDmg = Math.max(0, backDmg - 1);
  }

  targetUnit.defense -= fwdDmg;
  unit.defense -= backDmg;
  if (fwdDmg > 0) game.log.push(`${owner}'s ${unit.name} hits ${targetUnit.name} for ${fwdDmg}.`);
  if (backDmg > 0) game.log.push(`${targetUnit.name} retaliates against ${unit.name} for ${backDmg}.`);

  applyLifestealIfAny(game, owner, unit, fwdDmg);
  if (!isRanged) applyLifestealIfAny(game, opponentKey, targetUnit, backDmg);

  if (unit.keywords.includes('venom') && fwdDmg > 0 && targetUnit.defense > 0) {
    targetUnit.defense = 0;
    game.log.push(`${targetUnit.name} succumbs to Venom.`);
  }
  if (!isRanged && targetUnit.keywords.includes('venom') && backDmg > 0 && unit.defense > 0) {
    unit.defense = 0;
    game.log.push(`${unit.name} succumbs to Venom.`);
  }

  const targetSurvived = targetUnit.defense > 0;
  const attackerSurvived = unit.defense > 0;

  // Rage/Fortify on-survive triggers fire symmetrically for whichever side(s)
  // survived being hit — gated on "wasn't shielded" to match the pre-existing
  // rule that an absorbed hit never triggers these. Rage is repeatable
  // ("whenever") unless the card's own text says "first time".
  const applyRage = (target) => {
    const onceOnly = /first time/i.test(target.text);
    if (onceOnly && target.usedRage) return;
    const n = firstNumber(target.text, 1);
    target.power += n;
    target.basePower += n;
    target.usedRage = true;
    game.log.push(`${target.name} enters a Rage, permanently gaining +${n} DMG.`);
  };
  const applyFortify = (target) => {
    target.maxDefense += 1;
    target.defense += 1;
    game.log.push(`${target.name} is Fortified, gaining +1 HP.`);
  };
  if (!fwdShielded && targetSurvived && targetUnit.keywords.includes('rage')) applyRage(targetUnit);
  if (!fwdShielded && targetSurvived && targetUnit.keywords.includes('fortify')) applyFortify(targetUnit);
  if (!isRanged && !backShielded && attackerSurvived && unit.keywords.includes('rage')) applyRage(unit);
  if (!isRanged && !backShielded && attackerSurvived && unit.keywords.includes('fortify')) applyFortify(unit);

  // Slayer is a kill-trigger, not a survive-trigger like Rage — it rewards
  // landing the finishing blow, from either direction of the exchange.
  const applySlayer = (killer, victimName) => {
    killer.power += 1;
    killer.basePower += 1;
    game.log.push(`${killer.name} slays ${victimName}, permanently gaining +1 DMG.`);
  };
  if (!targetSurvived && unit.keywords.includes('slayer')) applySlayer(unit, targetUnit.name);
  if (!isRanged && !attackerSurvived && targetUnit.keywords.includes('slayer')) applySlayer(targetUnit, unit.name);

  if (!targetSurvived) {
    const overflow = -targetUnit.defense;
    destroyUnit(game, opponentKey, targetLane, targetSlot);
    if (unit.keywords.includes('trample') && overflow > 0) {
      const behind = targetLane === 'vanguard' ? opponent.board.rearguard[targetSlot] : null;
      if (behind) {
        behind.defense -= overflow;
        game.log.push(`Trample carries ${overflow} to ${behind.name}.`);
        if (behind.defense <= 0) destroyUnit(game, opponentKey, 'rearguard', targetSlot);
      } else {
        opponent.hp -= overflow;
        game.log.push(`Trample carries ${overflow} to the enemy castle.`);
      }
    }
  }
  if (!isRanged && !attackerSurvived) {
    const overflow = -unit.defense;
    destroyUnit(game, owner, attackerLane, attackerSlot);
    if (targetUnit.keywords.includes('trample') && overflow > 0) {
      const behind = attackerLane === 'vanguard' ? player.board.rearguard[attackerSlot] : null;
      if (behind) {
        behind.defense -= overflow;
        game.log.push(`Trample carries ${overflow} to ${behind.name}.`);
        if (behind.defense <= 0) destroyUnit(game, owner, 'rearguard', attackerSlot);
      } else {
        player.hp -= overflow;
        game.log.push(`Trample carries ${overflow} to the ${owner}'s castle.`);
      }
    }
  }

  checkWinner(game);
  return game;
}

export function endTurn(game, owner) {
  requireActive(game, owner);
  game.phase = 'end';
  const player = game.players[owner];
  const opponent = game.players[opponentOf(owner)];

  // End-of-turn triggers for the player whose turn is ending (Curse).
  for (const unit of allUnits(player)) {
    if (unit.keywords.includes('curse')) {
      const enemyUnits = allUnits(opponent);
      if (enemyUnits.length > 0) {
        const target = enemyUnits[Math.floor(Math.random() * enemyUnits.length)];
        const loc = findLaneOf(opponent, target.instanceId);
        target.defense -= 1;
        game.log.push(`${unit.name}'s Curse deals 1 to ${target.name}.`);
        if (target.defense <= 0) destroyUnit(game, opponentOf(owner), loc.lane, loc.idx);
      } else {
        opponent.hp -= 1;
        game.log.push(`${unit.name}'s Curse deals 1 to the enemy castle.`);
      }
    }
  }
  checkWinner(game);
  if (game.winner) return game;

  // The player whose turn just ended draws exactly 1 card.
  const drew = draw(player);
  if (!drew) {
    game.winner = opponentOf(owner);
    game.phase = 'gameover';
    game.log.push(`${owner}'s deck and graveyard are both empty — ${owner} decks out and loses!`);
    return game;
  }
  game.log.push(`${owner} draws a card.`);

  const next = opponentOf(owner);
  game.turnNumber += 1;
  startTurn(game, next);
  return game;
}

// Repositioning (front/back OR left/right) costs the unit's action for the
// turn (same attackedThisTurn flag attacking sets) — a straight alternative
// to attacking, not a free extra move. Exactly one orthogonal step is legal:
// same lane + adjacent slot (lateral), or same slot + different lane
// (front/back). No diagonals, no multi-step hops, no swapping into an
// occupied slot.
export function moveUnit(game, owner, fromLane, fromSlot, toLane, toSlot) {
  requireActive(game, owner);
  if (game.phase !== 'combat') throw new Error('Units can only reposition during the Combat phase.');
  if (fromLane !== 'vanguard' && fromLane !== 'rearguard') throw new Error('Invalid lane.');
  if (toLane !== 'vanguard' && toLane !== 'rearguard') throw new Error('Invalid lane.');
  if (toSlot < 0 || toSlot >= LANES) throw new Error('Invalid slot.');

  const player = game.players[owner];
  const unit = player.board[fromLane][fromSlot];
  if (!unit) throw new Error('No unit in that slot.');
  if (unit.sick) throw new Error('That unit has summoning sickness.');
  if (unit.attackedThisTurn) throw new Error('That unit has already used its action this turn.');

  const sameLane = toLane === fromLane;
  const sameSlot = toSlot === fromSlot;
  if (sameLane && sameSlot) throw new Error('Unit is already in that slot.');

  const isLateral = sameLane && Math.abs(toSlot - fromSlot) === 1;
  const isFrontBack = !sameLane && sameSlot;
  if (!isLateral && !isFrontBack) {
    throw new Error('Units may move exactly one step: forward/back in the same column, or one slot left/right in the same row.');
  }
  if (player.board[toLane][toSlot]) throw new Error('That slot is already occupied.');

  player.board[fromLane][fromSlot] = null;
  player.board[toLane][toSlot] = unit;
  unit.attackedThisTurn = true;

  if (isFrontBack) {
    game.log.push(`${owner}'s ${unit.name} moves to the ${toLane}.`);
  } else {
    game.log.push(`${owner}'s ${unit.name} moves ${toSlot > fromSlot ? 'right' : 'left'}.`);
  }
  return game;
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

// Pack Hunt/Formation bonuses fluctuate live with board state rather than
// being baked into unit.power, so the client needs the current effective
// value to display — computed here via the same effectivePower() combat
// already uses, so the shown number can never drift from the real damage.
function withDisplayPower(game, owner) {
  const player = game.players[owner];
  const annotate = (lane) =>
    player.board[lane].map((unit, idx) =>
      unit ? { ...unit, displayPower: effectivePower(game, owner, lane, idx) } : null
    );
  return { ...player, board: { vanguard: annotate('vanguard'), rearguard: annotate('rearguard') } };
}

export function viewFor(game, owner) {
  const opp = opponentOf(owner);
  return {
    you: withDisplayPower(game, owner),
    opponent: {
      ...withDisplayPower(game, opp),
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
