# Aether Realms: Clash of Armies

A 1v1 multiplayer card game built from a set of AI-generated TCG card codexes (Human, Elf, Dwarf, Orc) and a ruleset, both originally drafted in a Gemini chat. Runs entirely on Cloudflare Workers + Durable Objects — no database, no build step for the frontend.

## Play

1. Pick a faction.
2. **Create Match** to get a 6-character room code and share it, or **Join Match** with a code you were given.
3. Once both players are in, the match starts automatically.

## Rules (as implemented)

- Each Commander starts at 30 HP. Reduce the opponent's to 0 to win.
- Board: a 5-wide **Vanguard** row and a 5-wide **Rearguard** row per player.
- Turn: Ready (gain 1 max mana, up to 10; refill mana; draw a card) → Deployment (play cards) → Combat (attack) → End.
- A newly played unit has summoning sickness and can't attack the turn it's played, unless its text mentions **Charge**.
- Attacking a lane: if the enemy Vanguard slot in your column is occupied, you must hit it. If it's empty, you hit the enemy Rearguard in that column if occupied, otherwise you hit the enemy Commander directly.
- Damage persists between turns — units don't heal automatically.
- Decks are built automatically per faction: 3 copies of every standard card, 1 copy of each unique/leader card.

### Keywords that are mechanically implemented

Of the ~90 unique card abilities in the original chat, four shared keywords are wired up as real game logic (detected from each card's text):

- **Volley / Ranged** — may attack from the Rearguard, and may choose to hit the enemy Rearguard directly even if their Vanguard is occupied.
- **Phalanx / Shield-Wall** — takes 1 less damage from an attack.
- **Trample / Cleave** — damage left over after destroying its target carries to the unit behind it (or the Commander, if nothing is behind it).
- **Siege** — no Building/Castle cards were ever generated in the original chat, so this is adapted: a Siege unit's attack always lands on the enemy Commander directly.

Every other card's original ability text is still shown on the card as flavor — it just isn't individually coded yet. Some of the AI-generated card text also came out garbled or with stats replaced by leftover "sprite index" numbers (most noticeable on the Dwarf and Orc sheets); those have been cleaned up or reassigned reasonable values by hand so the game is actually playable and balanced.

## Project layout

```
src/
  worker.js       Routes + WebSocket upgrade, serves the static frontend
  matchRoom.js    Durable Object: authoritative per-match game state
  game/rules.js   Deck building, turn phases, combat resolution, keyword logic
public/
  index.html, style.css, client.js
  assets/*.png    Full-resolution card codex sheets (rendered as CSS/canvas sprite crops)
  data/*.json     Per-card metadata + sprite crop rectangles, one file per faction
```

## Local development

```bash
npm install
npm run dev
```

Open the printed local URL in two browser tabs to test a match against yourself.

## Deploy

```bash
npm run deploy
```
