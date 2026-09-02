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
  if (/precise|ignores? taunt/.test(t)) kw.push('precise');
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
    const copies = card.copies ?? (!FLAGSHIP_NAMES.has(card.name) && card.cost <= 3 ? 2 : 1);
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
    target: card.target || null,
    effect: card.effect || null,
  };
}

function emptyBoard() {
  return { vanguard: new Array(LANES).fill(null), rearguard: new Array(LANES).fill(null) };
}

export function opponentOf(owner) {
  return owner === 'A' ? 'B' : 'A';
}

export function createGame(factionA, factionB, firstPlayer = 'A', usernameA = null, usernameB = null) {
  const deckA = buildDeck(factionA);
  const deckB = buildDeck(factionB);
  const players = {
    A: {
      faction: factionA,
      username: usernameA,
      deck: deckA,
      hand: deckA.splice(0, STARTING_HAND_SIZE),
      board: emptyBoard(),
      graveyard: [],
      hp: STARTING_HP,
      maxHp: STARTING_HP,
      maxMana: 1,
      mana: 1,
      connected: false,
      castleShield: 0,
      turnDamageReduction: 0,
    },
    B: {
      faction: factionB,
      username: usernameB,
      deck: deckB,
      hand: deckB.splice(0, STARTING_HAND_SIZE),
      board: emptyBoard(),
      graveyard: [],
      hp: STARTING_HP,
      maxHp: STARTING_HP,
      maxMana: 1,
      mana: 1,
      connected: false,
      castleShield: 0,
      turnDamageReduction: 0,
    },
  };
  return {
    players,
    turn: firstPlayer,
    phase: 'coinflip',
    turnNumber: 1,
    winner: null,
    log: ['Match created — flipping a coin to see who goes first...'],
    pendingEffects: [],
    turnEffects: [],
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
  power += unit.turnPowerBonus || 0;
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

// Shared entry point for any non-combat source of damage to a unit (spells,
// mainly) — mirrors combat's Shield-absorption rule so a Shielded unit is
// consistently protected everywhere, not just against attacks. Returns the
// amount actually dealt (0 if absorbed).
function dealDamageToUnit(game, ownerKey, lane, slot, amount) {
  const player = game.players[ownerKey];
  const unit = player.board[lane][slot];
  if (!unit) return 0;
  if (unit.hasShield) {
    unit.hasShield = false;
    game.log.push(`${unit.name}'s Shield absorbs the hit.`);
    return 0;
  }
  const total = Math.max(0, amount + (unit.vulnerableBonus || 0) - (player.turnDamageReduction || 0));
  unit.defense -= total;
  if (unit.defense <= 0) destroyUnit(game, ownerKey, lane, slot);
  return total;
}

// Shared entry point for any damage aimed at a player's CASTLE (rather than a
// unit) so a castle ward (Runic Ward) is consistently respected wherever
// castle HP is reduced — combat breakthroughs, Countdown/Curse triggers, and
// castle-damage spells alike. Self-inflicted costs (Bloodprice) intentionally
// bypass this and hit player.hp directly — a player's own ward shouldn't
// block a price they chose to pay themselves.
function dealDamageToCastle(game, targetOwnerKey, amount) {
  const player = game.players[targetOwnerKey];
  const absorbed = Math.min(player.castleShield || 0, amount);
  if (absorbed > 0) {
    player.castleShield -= absorbed;
    game.log.push(`${targetOwnerKey}'s castle ward absorbs ${absorbed} damage.`);
  }
  const remaining = amount - absorbed;
  player.hp -= remaining;
  return remaining;
}

// "Until end of turn" spell buffs (as opposed to War Cry-style "until your
// next turn" buffs, which already persist via tempPowerBonus/startTurn) live
// in their own turnPowerBonus/turnDefenseBonus fields so they can be rolled
// back the moment the casting player's own turn ends, before the opponent
// ever has to deal with them. Debuffs placed on an ENEMY unit (e.g. Hunter's
// Mark) can't be found by scanning the caster's own board, so those are
// separately tracked in game.turnEffects, tagged with who cast them.
function revertEndOfTurnBuffs(game, owner) {
  const player = game.players[owner];
  for (const lane of ['vanguard', 'rearguard']) {
    player.board[lane].forEach((unit, idx) => {
      if (!unit) return;
      unit.turnPowerBonus = 0;
      if (unit.turnDefenseBonus) {
        unit.defense -= unit.turnDefenseBonus;
        unit.maxDefense -= unit.turnDefenseBonus;
        unit.turnDefenseBonus = 0;
        if (unit.defense <= 0) destroyUnit(game, owner, lane, idx);
      }
    });
  }

  const remaining = [];
  for (const te of game.turnEffects) {
    if (te.casterOwner !== owner) {
      remaining.push(te);
      continue;
    }
    const targetPlayer = game.players[te.targetOwner];
    const loc = findLaneOf(targetPlayer, te.targetInstanceId);
    if (loc) {
      const unit = targetPlayer.board[loc.lane][loc.idx];
      unit[te.field] = Math.max(0, (unit[te.field] || 0) - te.amount);
    }
  }
  game.turnEffects = remaining;
}

// Delayed spell effects (e.g. "deal 1 more damage at the start of your next
// turn") are queued here rather than tied to a unit's own countdown, since
// the source is a one-shot spell, not a persistent unit. Resolves whenever
// `owner`'s turn comes back around, however many turns that takes.
function processPendingEffects(game, owner) {
  const due = [];
  const remaining = [];
  for (const pe of game.pendingEffects) {
    if (pe.owner !== owner) {
      remaining.push(pe);
      continue;
    }
    pe.turnsRemaining -= 1;
    if (pe.turnsRemaining <= 0) due.push(pe);
    else remaining.push(pe);
  }
  game.pendingEffects = remaining;
  for (const pe of due) {
    if (pe.kind === 'damage_unit') {
      const targetPlayer = game.players[pe.targetOwner];
      const loc = findLaneOf(targetPlayer, pe.targetInstanceId);
      if (loc) {
        dealDamageToUnit(game, pe.targetOwner, loc.lane, loc.idx, pe.amount);
        game.log.push(`${pe.sourceName}'s delayed effect deals ${pe.amount} more damage.`);
      } else {
        game.log.push(`${pe.sourceName}'s delayed effect fizzles — the target is gone.`);
      }
    }
    if (pe.kind === 'heal_castle_delayed') {
      const healPlayer = game.players[owner];
      const before = healPlayer.hp;
      healPlayer.hp = Math.min(healPlayer.maxHp, healPlayer.hp + pe.amount);
      game.log.push(`${pe.sourceName} heals ${owner} for ${healPlayer.hp - before}.`);
    }
  }
  checkWinner(game);
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
  player.castleShield = 0;
  player.turnDamageReduction = 0;
  processPendingEffects(game, owner);
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
    dealDamageToCastle(game, opponentOf(owner), dmg);
    game.log.push(`${unit.name}'s Countdown deals ${dmg} to the enemy castle.`);
  }
  if (/draw a card/i.test(unit.text)) {
    draw(game.players[owner]);
    game.log.push(`${owner} draws a card (Countdown).`);
  }
  checkWinner(game);
}

// Spell effects are parsed from the printed text the same way keywords are —
// no per-card handler to maintain, any future "Draw N cards" spell just works.
function resolveSpell(game, owner, card) {
  const player = game.players[owner];
  const drawMatch = (card.text || '').match(/draw (\d+) cards?/i);
  if (drawMatch) {
    const n = parseInt(drawMatch[1], 10);
    let drew = 0;
    for (let i = 0; i < n; i++) {
      if (draw(player)) drew++;
    }
    game.log.push(`${owner} draws ${drew} card(s) (${card.name}).`);
  }
}

// Structured spell effects (as opposed to the legacy text-parsed
// resolveSpell() above, kept for cards with no `effect` field, e.g. Ancient
// Wisdom) — one `kind` per mechanical shape, each keyed off `card.target`
// to know whose board `target.lane`/`target.slot` refers to.
function resolveSpellEffect(game, owner, card, target) {
  const player = game.players[owner];
  const opponent = game.players[opponentOf(owner)];
  const eff = card.effect;
  const targetOwnerKey =
    card.target === 'enemy_unit' || card.target === 'multi_enemy_unit' || card.target === 'multi_enemy_unit_distinct'
      ? opponentOf(owner)
      : owner;

  switch (eff.kind) {
    case 'buff_power': {
      const unit = game.players[targetOwnerKey].board[target.lane][target.slot];
      if (unit) {
        unit.turnPowerBonus = (unit.turnPowerBonus || 0) + eff.amount;
        game.log.push(`${card.name} gives ${unit.name} +${eff.amount} DMG until end of turn.`);
      }
      break;
    }
    case 'buff_defense': {
      const unit = game.players[targetOwnerKey].board[target.lane][target.slot];
      if (unit) {
        unit.defense += eff.amount;
        unit.maxDefense += eff.amount;
        unit.turnDefenseBonus = (unit.turnDefenseBonus || 0) + eff.amount;
        game.log.push(`${card.name} gives ${unit.name} +${eff.amount} HP until end of turn.`);
      }
      break;
    }
    case 'heal': {
      const unit = game.players[targetOwnerKey].board[target.lane][target.slot];
      if (unit) {
        const before = unit.defense;
        unit.defense = Math.min(unit.maxDefense, unit.defense + eff.amount);
        game.log.push(`${card.name} heals ${unit.name} for ${unit.defense - before}.`);
      }
      break;
    }
    case 'heal_castle': {
      const before = player.hp;
      player.hp = Math.min(player.maxHp, player.hp + eff.amount);
      game.log.push(`${card.name} heals ${owner} for ${player.hp - before}.`);
      break;
    }
    case 'damage': {
      dealDamageToUnit(game, targetOwnerKey, target.lane, target.slot, eff.amount);
      game.log.push(`${card.name} deals ${eff.amount} damage.`);
      break;
    }
    case 'grant_shield': {
      const unit = game.players[targetOwnerKey].board[target.lane][target.slot];
      if (unit) {
        unit.hasShield = true;
        game.log.push(`${unit.name} gains Shield from ${card.name}.`);
      }
      break;
    }
    case 'draw_conditional': {
      const n = allUnits(player).length >= eff.threshold ? eff.base + eff.bonus : eff.base;
      let drew = 0;
      for (let i = 0; i < n; i++) if (draw(player)) drew++;
      game.log.push(`${owner} draws ${drew} card(s) (${card.name}).`);
      break;
    }
    case 'buff_power_row': {
      const row = player.board[target.lane];
      row.forEach((u) => {
        if (u) u.tempPowerBonus = (u.tempPowerBonus || 0) + eff.amount;
      });
      game.log.push(`${card.name} gives ${owner}'s ${target.lane} +${eff.amount} DMG until ${owner}'s next turn.`);
      break;
    }
    case 'damage_then_delayed': {
      dealDamageToUnit(game, targetOwnerKey, target.lane, target.slot, eff.amount);
      game.log.push(`${card.name} deals ${eff.amount} damage.`);
      const stillAlive = game.players[targetOwnerKey].board[target.lane][target.slot];
      if (stillAlive) {
        game.pendingEffects.push({
          owner,
          turnsRemaining: 1,
          kind: 'damage_unit',
          amount: eff.delayedAmount,
          targetOwner: targetOwnerKey,
          targetInstanceId: stillAlive.instanceId,
          sourceName: card.name,
        });
      }
      break;
    }
    case 'damage_castle': {
      dealDamageToCastle(game, opponentOf(owner), eff.amount);
      game.log.push(`${card.name} deals ${eff.amount} to the enemy castle.`);
      break;
    }
    case 'split_damage': {
      for (const hit of target.hits) {
        dealDamageToUnit(game, targetOwnerKey, hit.lane, hit.slot, 1);
      }
      game.log.push(`${card.name} splits ${target.hits.length} damage among enemy units.`);
      break;
    }
    case 'multi_damage': {
      for (const hit of target.hits) {
        dealDamageToUnit(game, targetOwnerKey, hit.lane, hit.slot, eff.amount);
      }
      game.log.push(`${card.name} deals ${eff.amount} damage to each of ${target.hits.length} enemy units.`);
      break;
    }
    case 'vulnerable': {
      const unit = game.players[targetOwnerKey].board[target.lane][target.slot];
      if (unit) {
        unit.vulnerableBonus = (unit.vulnerableBonus || 0) + eff.amount;
        game.turnEffects.push({
          casterOwner: owner,
          targetOwner: targetOwnerKey,
          targetInstanceId: unit.instanceId,
          field: 'vulnerableBonus',
          amount: eff.amount,
        });
        game.log.push(`${card.name} makes ${unit.name} take +${eff.amount} damage until end of turn.`);
      }
      break;
    }
    case 'bounce': {
      const unit = player.board[target.lane][target.slot];
      if (unit) {
        player.board[target.lane][target.slot] = null;
        unit.defense = unit.maxDefense;
        unit.power = unit.basePower;
        unit.tempPowerBonus = 0;
        unit.turnPowerBonus = 0;
        unit.turnDefenseBonus = 0;
        unit.vulnerableBonus = 0;
        unit.hasShield = unit.keywords.includes('shield');
        delete unit.sick;
        delete unit.attackedThisTurn;
        player.hand.push(unit);
        game.log.push(`${card.name} returns ${unit.name} to ${owner}'s hand.`);
      }
      break;
    }
    case 'damage_conditional_hp': {
      const amount = player.hp < player.maxHp / 2 ? eff.lowHpAmount : eff.amount;
      dealDamageToUnit(game, targetOwnerKey, target.lane, target.slot, amount);
      game.log.push(`${card.name} deals ${amount} damage.`);
      break;
    }
    case 'draw_conditional_hp': {
      const n = player.hp < player.maxHp / 2 ? eff.lowHpAmount : eff.amount;
      let drew = 0;
      for (let i = 0; i < n; i++) if (draw(player)) drew++;
      game.log.push(`${owner} draws ${drew} card(s) (${card.name}).`);
      break;
    }
    case 'grant_castle_shield': {
      player.castleShield = (player.castleShield || 0) + eff.amount;
      game.log.push(`${card.name} wards ${owner}'s castle against the next ${eff.amount} damage.`);
      break;
    }
    case 'heal_all_allies': {
      let healedAny = false;
      for (const u of allUnits(player)) {
        if (u.defense < u.maxDefense) {
          u.defense = Math.min(u.maxDefense, u.defense + eff.amount);
          healedAny = true;
        }
      }
      game.log.push(`${card.name} heals ${owner}'s units for ${eff.amount}${healedAny ? '' : ' (none were hurt)'}.`);
      break;
    }
    case 'damage_reduction_team': {
      player.turnDamageReduction = (player.turnDamageReduction || 0) + eff.amount;
      game.log.push(`${card.name} makes ${owner}'s units take ${eff.amount} less damage until ${owner}'s next turn.`);
      break;
    }
    case 'damage_all_enemies': {
      for (const lane of ['vanguard', 'rearguard']) {
        opponent.board[lane].forEach((u, idx) => {
          if (u) dealDamageToUnit(game, opponentOf(owner), lane, idx, eff.amount);
        });
      }
      game.log.push(`${card.name} deals ${eff.amount} damage to all of ${opponentOf(owner)}'s units.`);
      break;
    }
    case 'delayed_heal_castle_repeat': {
      for (let i = 1; i <= eff.times; i++) {
        game.pendingEffects.push({
          owner,
          turnsRemaining: i,
          kind: 'heal_castle_delayed',
          amount: eff.amount,
          sourceName: card.name,
        });
      }
      break;
    }
    default:
      break;
  }
  checkWinner(game);
}

// Confirms `target` is a legal choice for `card.target` before any mana is
// spent or state changes — the single gate every spell cast passes through,
// mirroring how getLegalAttackTargets() gates attacks.
function validateSpellTarget(game, owner, card, target) {
  const kind = card.target || 'none';
  if (kind === 'none') return;
  const opp = game.players[opponentOf(owner)];
  const you = game.players[owner];
  if (kind === 'ally_unit') {
    if (!target || !you.board[target.lane]?.[target.slot]) throw new Error('Choose a valid allied unit to target.');
  } else if (kind === 'enemy_unit') {
    const targetUnit = target && opp.board[target.lane]?.[target.slot];
    if (!targetUnit) throw new Error('Choose a valid enemy unit to target.');
    if (card.effect?.maxTargetPower !== undefined && targetUnit.power > card.effect.maxTargetPower) {
      throw new Error(`This spell can only target units with ${card.effect.maxTargetPower} or less DMG.`);
    }
  } else if (kind === 'ally_row') {
    if (!target || (target.lane !== 'vanguard' && target.lane !== 'rearguard')) {
      throw new Error('Choose a row to target.');
    }
  } else if (kind === 'multi_enemy_unit') {
    const eff = card.effect;
    if (!target || !Array.isArray(target.hits) || target.hits.length !== eff.total) {
      throw new Error('Choose valid targets for this spell.');
    }
    const distinct = new Set(target.hits.map((h) => `${h.lane}:${h.slot}`));
    if (distinct.size > eff.maxTargets) throw new Error('Too many different targets for this spell.');
    for (const h of target.hits) {
      if (!opp.board[h.lane]?.[h.slot]) throw new Error('Invalid target in split damage.');
    }
  } else if (kind === 'multi_enemy_unit_distinct') {
    const eff = card.effect;
    if (!target || !Array.isArray(target.hits) || target.hits.length !== eff.count) {
      throw new Error('Choose valid targets for this spell.');
    }
    const distinct = new Set(target.hits.map((h) => `${h.lane}:${h.slot}`));
    if (distinct.size !== target.hits.length) throw new Error('Targets must be different units.');
    for (const h of target.hits) {
      if (!opp.board[h.lane]?.[h.slot]) throw new Error('Invalid target.');
    }
  }
}

export function playCard(game, owner, cardInstanceId, lane, slotIndex, spellTarget) {
  requireActive(game, owner);
  if (game.phase !== 'deployment') throw new Error('Cards can only be played during the Deployment phase.');
  const player = game.players[owner];
  const idx = player.hand.findIndex((c) => c.instanceId === cardInstanceId);
  if (idx === -1) throw new Error('Card not in hand.');
  const card = player.hand[idx];
  if (card.cost > player.mana) throw new Error('Not enough mana.');

  if (card.type === 'spell') {
    validateSpellTarget(game, owner, card, spellTarget);
    player.hand.splice(idx, 1);
    player.mana -= card.cost;
    game.log.push(`${owner} casts ${card.name}.`);
    if (card.effect) {
      resolveSpellEffect(game, owner, card, spellTarget);
    } else {
      resolveSpell(game, owner, card);
    }
    player.graveyard.push(card);
    checkWinner(game);
    return card;
  }

  if (lane !== 'vanguard' && lane !== 'rearguard') throw new Error('Invalid lane.');
  if (slotIndex < 0 || slotIndex >= LANES) throw new Error('Invalid slot.');
  if (player.board[lane][slotIndex]) throw new Error('That slot is already occupied.');
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
        dealDamageToCastle(game, opponentOf(owner), 2);
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

// Single source of truth for "can this attacker legally hit this target" —
// used by attack()'s validation, the client's target highlighting, and the
// Attack-All auto-combat loop. Returns a flat list of concrete targets:
// { type: 'unit', lane, slot } or { type: 'castle' }.
//
// Vanguard is always targetable regardless of column (no more same-slot
// lock). A Rearguard is targetable once its OWN column's Vanguard is gone,
// or by a Volley/Ranged attacker regardless. The castle is targetable once
// at least one column has no Vanguard. Taunt overrides all of this: any
// reachable Taunt unit becomes the only legal target, including over the
// castle, until no reachable Taunt remains — unless the attacker is Precise,
// which ignores Taunt entirely and targets as if none were up.
export function getLegalAttackTargets(game, owner, attackerLane, attackerSlot) {
  const unit = game.players[owner].board[attackerLane][attackerSlot];
  if (!unit) return [];
  const oppBoard = game.players[opponentOf(owner)].board;
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
  for (let col = 0; col < LANES; col++) {
    if (oppBoard.vanguard[col]) targets.push({ type: 'unit', lane: 'vanguard', slot: col });
    if (oppBoard.rearguard[col] && (isRanged || !oppBoard.vanguard[col])) {
      targets.push({ type: 'unit', lane: 'rearguard', slot: col });
    }
    if (!oppBoard.vanguard[col]) castleReachable = true;
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
    const dealt = dealDamageToCastle(game, opponentKey, attackPower);
    game.log.push(`${owner}'s ${unit.name} breaks through and hits the enemy castle for ${attackPower}.`);
    applyLifestealIfAny(game, owner, unit, dealt);
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
    fwdDmg = attackPower + (targetUnit.vulnerableBonus || 0);
    if (targetUnit.keywords.includes('phalanx')) fwdDmg = Math.max(0, fwdDmg - 1);
    if (hasFormationToughness(game, opponentKey, targetLane, targetSlot)) fwdDmg = Math.max(0, fwdDmg - 1);
    fwdDmg = Math.max(0, fwdDmg - (opponent.turnDamageReduction || 0));
  }
  let backDmg = 0;
  if (!isRanged && !backShielded) {
    backDmg = defenderPower + (unit.vulnerableBonus || 0);
    if (unit.keywords.includes('phalanx')) backDmg = Math.max(0, backDmg - 1);
    if (hasFormationToughness(game, owner, attackerLane, attackerSlot)) backDmg = Math.max(0, backDmg - 1);
    backDmg = Math.max(0, backDmg - (player.turnDamageReduction || 0));
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
        dealDamageToCastle(game, opponentKey, overflow);
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
        dealDamageToCastle(game, owner, overflow);
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

  revertEndOfTurnBuffs(game, owner);

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
        dealDamageToCastle(game, opponentOf(owner), 1);
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
