# IRL Tag - Minecraft V2

## Run it
1. Open PowerShell in the `backend` folder, run `node server.js`
2. Open a second PowerShell, run `ngrok http 3000`
3. Everyone opens the ngrok link on their phone (allow Location when asked)

## What's new
- Minecraft look: Steve running with a zombie chasing him on the main screen, End portal between screens, Nether portal when the game starts, role reveal card, block-style map and markers.
- GPS: starts in the lobby, map zooms to YOUR real spot, follows you (drag the map to stop, "Center on Me" to resume), screen stays awake, phone clock no longer breaks it, weak/paused GPS is shown on screen.
- Refreshing the page puts you back in your game.
- Tag codes: 3 wrong tries = 60 second lock. Lowercase works.
- Fake teleporting GPS is rejected.
- Extra Health: 3 checkpoints about 0.9-1.6 km apart in total, your 12-minute clock starts at checkpoint 1, then hold 2 minutes.
- Ghost Mode: earned from an easy quest, one use per team.
- Safe zone: random spot anywhere in the main circle, but always overlapping the old zone. Shrinks by 25% each time.
- Host picks the center on the map (starts on the host's GPS). No more silent default center.
- Game codes are no longer listed publicly.

## Known limits
- If a phone locks or you switch apps, its GPS can pause. Keep the screen on.
- Games live in memory: restarting the server ends them.
- Smooth fake-walking GPS apps can still cheat (only teleports are blocked).
- The Google Maps key is inside index.html. Restrict it in Google Cloud.

## V2.1 (map colors + safe zone alerts)
- New dark map: charcoal land, light grey/white roads. Nothing orange, yellow, cyan, green or red in the base map.
- Cyan thick ring = current safe zone. Lime green thick ring + tint = NEW safe zone. Purple ring = game border. Red tint = everywhere outside the safe zone. Red circle = danger zone, gold circle = buff zone.
- When the safe zone starts shrinking: big banner "SAFE ZONE IS NOW SHRINKING" + countdown, phone vibrates (Android) and beeps.
- Red banner "YOU ARE OUTSIDE - MOVE!" with distance + direction, or green banner "YOU ARE INSIDE THE NEW SAFE ZONE". Reminders at 30s and 10s left if still outside.
- Banner also tells runners if a teammate being inside keeps the team safe (same rule the server uses).
- After the zone moves, a short message says if you are inside or outside. If you leave the safe area at any time you get a warning.

## V2.3 (custom teams + teams pop-up)
- Create Game > Players Per Team > "Custom": two boxes open (Number of Runners, Number of Taggers). Every runner plays solo, all taggers hunt together as one team. You need exactly runners + taggers players to start. Roles are picked randomly.
- Tap the team box at the top of the game screen: a pop-up slides in from the left with every team, who is a Tagger or Runner, and each player's registered name (marker code next to it, like D1 = Team 4, player 1).
- Tap any player square on the map to see their name, team and whether they are live.
- Team tab now lists your own team's player names too.
- Top box shows "Tagger: Team 1 - 3 left" so you can see how many runner teams are still in.
- Your own square is no longer drawn twice. GPS asks the phone for a fresh fix if updates pause.

## V2.4 (cleaner game screen + fixes)
Screen layout, top to bottom:
- Top bar: your role + team (tap it for all teams and players) and TIME LEFT / HEAD START.
- Status chips: head start countdown, SAFE / OUTSIDE zone status with next shrink time, REVEAL (when taggers see runners) or SNAPSHOT countdown, GPS, STOP penalty, NO CONNECTION. "?" opens the map key.
- Right side: power-up bar (Extra Health, Ghost, Smoke, Vision, Bonus Snapshot, Ping and active timers). Tap one to use it (asks first).
- Bottom left: quest tracker with progress, distance + direction to the next spot and time left.
- Bottom right (taggers): big TAG button, shows the STOP penalty countdown.
- Pop-up alerts for: taggers released, snapshots, new danger/buff zones, teams tagged out, quests done/failed, power-ups gained, vision on, Extra Health used. "YOU WERE TAGGED OUT" card when you are out.
- Chat button shows unread messages.

Fixes:
- GPS no longer shows "stale" when you stand still (it keeps confirming your spot for up to 90 s, then says paused).
- Lobby: host can remove players (X), anyone can Leave Lobby, custom games refuse extra players, removed players get a message.
- Lost connection shows a chip and recovers by itself; if the server restarted you get a clear message.
- Server: one broken game can no longer crash everything, oversized requests are refused, errors are logged instead of killing the server.
