# Polished IRL Game - The Finale (Diwali build)

Three new features. Everything else (snapshots, Extra Health, Ghost, Smoke, Vision, safe zone, chat, presets) works as before.

## 1) Bait quests
- The server drops a "Supply Drop" (reach it) or "Hold the Drop" (stay 30s) quest on some runner teams. It looks like a normal quest but has an orange "!" marker and a small RISKY tag.
- Two triggers: (a) when a Danger Zone appears, the drop is placed at the rim of that zone (partly inside it, so runners get seen live by taggers); (b) when the safe zone starts shrinking, the drop is placed right at the rim of the new safe zone.
- Reward: DOUBLE Vision Burst (2 charges, normal quests give 1).
- Limits: only runner teams, one open bait quest per team at a time, max 3 per team per game, always inside the play area, and the drop disappears when the danger zone / zone move is over (the quest list shows a timer). The server decides everything (isBait: true in the quest state).
- Note: this build has no road-snapping system, so targets are not snapped to roads.

## 2) Team callouts
- New "Call" button on the bottom bar: HELP, HIDE, SPLIT, NORTH, SOUTH, EAST, WEST.
- Only teammates see them (toast + a ping on the map at the sender's spot for a few seconds). Taggers' callouts are only seen by taggers.
- Server checks the sender is on an active team and the game is running; one callout per player every 6 seconds. Chat is untouched.

## 3) Post-game MVP
- When the game ends (all runners tagged, timer, or host ends it) the server scores every player and the Game Over screen shows the MVP card with the top 3.
- Points: Tagger = 40 per tag, 10 per absorbed tag. Runner = up to 40 for survival time, +25 for surviving to the end, 10 per risky quest. Everyone: 15 per quest, up to 30 for distance (3 per km), up to 5 for callouts.
- Also fixed: the Match Stats box on the Game Over screen was missing, it shows now.
