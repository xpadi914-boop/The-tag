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

## 6) Zone preview on the create screen (Game Presets AND Custom Game)
- When the host picks the game center, a green ring shows the real zone size around it. It works the same in both modes.
- The ring follows the marker LIVE while you drag it, jumps to wherever you tap, and changes size as you type the radius.
- The map no longer jumps around. It only zooms to fit the ring when the first center is picked (or GPS finds you), when the radius changes (after you stop typing), or when the create sheet is re-opened. Dragging and tapping never re-zoom.
- The note under the map says the radius and how wide the zone is, for example "Zone preview: 3,000 m radius (6 km across)".
- If you type a radius outside 400 m to 20,000 m, the ring shows what the game will REALLY use and the note says so (for example "you typed 80", the game uses 400 m).
- A slow GPS fix can no longer replace a center the host already tapped.
- The ring, the "Zone radius" line in the preset box, and the radius actually sent to the server now all use the same number (before, a blank radius previewed 500 m but created 3,000 m, and a blank duration previewed 60 min but created 5 min).

## 7) Bugs found by full-game testing, and fixed
- A team knocked out by the SHRINKING ZONE was recorded as having survived. MVP and Battle Cards showed it as "SURVIVED" with 0:00 alive. Now it is recorded like a tag elimination (not survived, with the time it went out). This happened in about 1 of every 3 games.
- Preset timings (head start, shrink times) are now worked out from the same clamped duration and radius the game really uses.

## Testing
- hard_test.js: all existing tests plus a new test for the zone-elimination bug.
- full_game_fuzz.js (new, no installs needed): plays whole games by itself. Try `node full_game_fuzz.js 500`. It checks every rule after every step: zones only shrink, stay inside the original zone, quests stay on roads, no eliminated team comes back, MVP and Battle Cards are right, and nothing crashes.
- Run on this version: 10,000+ full games with no problems.

## 8) Quests not appearing + slow Start (they had the same cause)
- Quests only spawn on roads, and road data comes from OpenStreetMap servers. When that data did not load, there were no quests at all, and Start waited up to 10 seconds for it every time.
- Start never waits for road data any more. It starts at once; quests appear the moment roads are loaded (also during the head start).
- Road loading is much sturdier: all 5 road servers are asked at the same time (first good answer wins), it retries 3 times, and the answer is remembered so the next game in the same place gets roads instantly.
- Areas with almost no real streets (campus, park, village): walkable paths (footways, paths, tracks, pedestrian ways) are used too, so quests still appear. Areas with plenty of streets still use streets only.
- Backup: if the SERVER cannot reach the road servers, the HOST'S PHONE fetches the roads and uploads them (new route /api/roads, host only, only points inside the game area are kept).
- The host sees the road status in the lobby (loading / ready / problem). Players see "Waiting for road data..." in the Quests panel instead of a blank list.
- Render log lines to look for: "[ROADS] game ABC123: 842 road points" (good), "[ROADS] load failed (try 1/3) ..." with the reason, "(uploaded by the host's phone)", "(remembered from an earlier game here)".

## 9) My Rules role picker closing by itself
- The lobby player list was rebuilt every second, which destroyed the Runner/Tagger dropdown while you were choosing. Now the list is left alone while a dropdown is open, and only redrawn when something actually changed. Same fix for the "Choose teammate" dropdown.

## 10) Minimum zone is now 400 m
- 400 and above can be set freely. Anything below 400 becomes 400 (the preview ring and note say so). Changed on the create screen, the preview, and the server.

## More tests
- roads_test.js (new): failing/hanging road servers, footpath fallback, memory, host-phone upload, and that Start takes milliseconds. Run `node roads_test.js`.
- full_game_fuzz.js now also plays 400 m games.

## 11) Tagging: "Invalid code" when the tag actually worked
- Cause: after a tag worked, the runner team was already out. If the same code was sent again (a second tap on a slow connection), the server answered "Invalid code" AND counted it as a wrong guess. The tagger saw only that last error, kept trying, and got locked for a minute.
- Now a repeat of a tag that already worked gets the same SUCCESS answer and never counts as a wrong guess. The code of a team that is already out (out from the zone or another team) says "Team N is already out" and is not a wrong guess either. Truly wrong codes still say "Invalid Team Code (n tries left)" and still lock after 3.
- On the tagger's screen: the TAG TEAM button shows "TAGGING..." and ignores extra taps while waiting. A right code shows a confirmation, clears the box and closes the tag tab. A wrong code shows the error in red and keeps the tab open.

## 12) Replay on the end screen
- Cause: the end screen was redrawn every second by the page refresh, which wiped the replay map about a second after pressing Replay. A second try showed nothing because the old map was still attached to the deleted box.
- Now the end screen is only redrawn when something actually changed, each replay builds a fresh map, and the replay draws the route as a growing line with a moving dot.
- A team's replay now follows ONE teammate's route. Before, it mixed all teammates by time, so duos' replays jumped back and forth.

## 13) Forfeits: 20 more
- 26 forfeits now (the original 6 plus 20 new ones, for example "Buy chai for the winners", "Talk like a pirate for 10 minutes", "Be the winners' butler for 15 minutes").
