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

## 4) Quests only on roads (strict)
- Every quest target (normal, 3-point extraction stages, hunter mark, and the risky Supply Drops) is placed exactly on a road. If no road data is available there is no fallback to a random spot: the quest just waits.
- "Road" = real streets only (primary, secondary, tertiary, residential, service lanes, etc). Footpaths, tracks, cycleways, motorways, private roads, tunnels, driveways and parking aisles are ignored.
- Road lookup tries 3 OpenStreetMap servers instead of 1. It runs when the game is created, so it's usually ready before Start. If it still fails, the game starts anyway, quests appear as soon as the lookup works (retries every 30s), and Start never hangs more than 10s waiting for it.
- Risky Supply Drops are skipped (not dropped off-road) if there's no road within 250m of the spot.
- Nothing else changed. hard_test.js now gives test games a fake street grid and has new road-only tests.

## 5) Zone shrinking: real shrink, smaller every time, neater on screen
- Each new zone is always smaller than the previous one. It can land anywhere inside your ORIGINAL zone (never outside it), so it relocates while it shrinks. Example with an 80m start: 80m, then 60m inside it, then maybe 45m shifted to the right but still inside the first 80m, and so on. The new zone's centre must be inside the current zone so every team can reach it. (Before, the zone stopped getting smaller at a fixed minimum, so it only relocated.)
- The minimum size now scales with your radius. For big games it's the same as before (250m normal, 180m final). For smaller games it's lower (about 15% of the start radius, e.g. 75m for a 500m game) so zones keep getting smaller. When the zone can't shrink any more, it just stops shrinking (it never grows back).
- On screen: only ONE ring now. It glides smoothly from the big old zone to the small new one (moving to its new spot while it gets smaller) (purple while shrinking, green when settled), and the red "outside" shading follows that same ring. Before, the red shading jumped straight to the final zone while a purple ring was still animating, plus a second purple border line, which is what made the mess.
- The faint outline of your original play area is now a thin, light grey line instead of a second purple one.
- The shrink animation follows the server clock, so a phone with a wrong clock doesn't show the ring early/late.
- Minimum radius on the create screen is still 500m (the server also enforces it); smaller values get bumped up to 500m.
