# IRL Tag v4 — Hardcore Regression Test Report

## Result
**PASS — no known blocking backend/game-rule failures remain from the previous report.**

## Fixed
- Create Lobby now scrolls vertically on small screens.
- Google Maps failure no longer leaves a silent black screen; the game shows a recoverable map error state.
- Safe-zone relocation warning now displays a live countdown for players outside the pending zone.
- Safe-zone relocation is hard-clamped to a minimum of 120 seconds.
- Safe-zone progression now scales with total game duration instead of using a fixed 3–5 minute interval.
- Initial safe period is bounded so short games still have time to progress.
- Runner clients now receive the Tagger team's identity/role but **never receive Tagger coordinates** unless an explicit vision exception is active.
- Runner map markers now carry team color and player index labels (e.g. R1/R2/R3 and G1/G2/G3).
- Safe zones, Danger Zones and Buff Zones are generated so the full zone remains inside the original playable boundary.
- Buff Zone vision can trigger only once per team per individual Buff Zone; standing inside cannot repeatedly farm the same zone.
- GPS UI reports accuracy and changes to `GPS: stale` when the player's last server location is older than 30 seconds.
- Host can end a running game through an authenticated server endpoint.
- Chat has server-side rate limiting (5 messages per 10 seconds per player) plus empty-message rejection.
- The center picker no longer silently replaces the host's chosen center with the host's device GPS.
- Existing server-side identity/session validation remains enforced.

## Automated tests
### Backend hard tests
PASS:
- 1/2/3/4/5/8-player team formation
- Invalid non-divisible team counts rejected
- Tagger role is revealed without Tagger location leakage
- Runner live-location visibility
- Tagger snapshot-only visibility
- Head-start tagging lock
- Team-wide Extra Health reward
- Secret-code rotation after Extra Health
- Old code rejection / new code activation
- Duration-scaled Extra Health penalty
- Safe-zone containment inside original boundary
- Minimum 2-minute relocation rule
- Short vs. long game safe-period scaling
- Ghost charge and duplicate-activation protection
- One-use-per-Buff-Zone vision trigger

### HTTP hard tests
PASS:
- Authenticated lobby creation/join
- Cross-session state access rejected
- Team formation through API
- Safe-zone settings normalized server-side
- One Tagger role per game
- Chat rate limiting
- Host-only game termination

### Frontend static hard checks
PASS:
- Create Lobby overflow scrolling rule present
- Map failure/retry overlay present
- Safe-zone countdown present
- Tagger identity display present
- Team-colored individual markers present
- Host end-game control present
- GPS stale-state indicator present
- Center picker no longer auto-overwrites selection with device GPS
- Frontend JavaScript syntax check
- Backend JavaScript syntax check

## Remaining limitations that require real devices / production services
These cannot be honestly certified by a local automated test:
- Physical GPS accuracy in dense buildings/trees/urban canyons.
- Android/iOS background-location behavior.
- Battery consumption over a full match.
- Google Maps behavior with the production API key, billing, quotas and network conditions.
- Real outdoor road accessibility for randomly generated zones.
- Multi-phone radio/network conditions.

## Baseline gameplay preserved
- Physical tag is **not GPS proximity**.
- A Tagger enters the caught team's secret code to register the tag.
- Tagger location is normally invisible to Runners.
- Taggers normally receive periodic Runner snapshots.
- Runner live visibility remains asymmetric as specified.
- Team quests are shared: one member can complete a quest and the reward belongs to the whole team.
- Extra Health rotates the team code and imposes a server-controlled Tagger penalty.
- Ghost Mode is earned, charged, timed and server-controlled.
