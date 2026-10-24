# IRL TAG – Corrected authoritative multiplayer build

This build fixes the core gameplay/security rules before UI redesign.

## Fixed rules

- Host-selectable team size: 1–8 players per team.
- Team formation: Random Teams or Choose Teammates. In Choose Teammates mode, players can select a teammate in the lobby; mutual choices are preserved when possible and remaining slots are filled randomly. The server randomly forms equal-sized teams from the lobby; at least 2 teams are required.
- The host/creator is included as an ordinary player after the game starts.
- The lobby creator is a normal player after game creation. The creator has no special gameplay powers.
- The host explicitly picks the map center during game creation.
- The initial playable boundary is a circle around that chosen center and the configured radius.
- The host's later GPS position does not move the boundary or safe-zone origin.
- Head start is configurable; the UI defaults to 5 minutes.
- Runner snapshot interval is configurable; the UI defaults to 5 minutes.
- Tagging is server-locked until the head start has ended.
- Runner -> Runner is live unless Ghost Mode is active.
- Runner -> Tagger is hidden normally.
- Tagger -> Runner is snapshot-only normally.
- Danger Zones can temporarily make Runner locations live to Taggers.
- Buff Zones can temporarily grant temporary opposing-team vision.
- Buff Zones are deliberately rare and capped.
- Ghost Mode is not infinitely spammable. It requires a server-earned charge and consumes one charge when activated.
- Extra Health is only awarded by the difficult timed three-stage extraction quest: three ordered checkpoints + 2-minute final hold + 12-minute quest limit.
- Extra Health is a team-wide reward. Any one team member can complete the extreme quest; the reward is granted to the whole team, so the quest does not require every teammate to participate.
- When Extra Health is awarded, the server rotates that team’s secret code. The new code is the only code that can trigger the Extra Health result when a Tagger enters it.
- When Extra Health absorbs a tag, the Tagger team receives a server-controlled movement penalty scaled to game duration: 10-minute games use 1 minute; 60-minute games use 5 minutes, with proportional scaling between those bounds.
- Safe-zone movement is generated randomly within the original playable circle, rather than repeatedly moving around the original center/current center.
- Safe-zone relocation has a server-controlled countdown before elimination.
- GPS updates require valid coordinates, a fresh timestamp, and a reported accuracy value. Implausible movement is flagged server-side rather than blindly trusted.
- Player session tokens prevent one client from loading another player's private state by changing a player ID.

## Game-creation controls

The creator can configure:

- Game duration
- Runner location snapshot interval
- Runner head start
- Initial game radius
- Initial safe period
- Safe-zone relocation time
- Zone spawn difficulty
- Map center

The host becomes an ordinary player once the game begins.

## GPS / map behavior

The mobile web client requests high-accuracy device location with fresh samples (`enableHighAccuracy`, `maximumAge: 0`) and sends the device's reported accuracy to the authoritative server. The Google map remains a road map and displays a GPS accuracy circle around the player.

A phone's actual GPS hardware, sky visibility, permissions, and device conditions determine physical accuracy; software cannot guarantee centimeter-level GPS from an ordinary phone.

## Test result

The corrected build was tested locally with HTTP multiplayer-style tests:

- Private session-token authorization: PASS
- Cross-player state access: BLOCKED
- Invalid GPS values: BLOCKED
- Invalid GPS bounds: BLOCKED
- Poor GPS accuracy: BLOCKED
- Valid GPS update: PASS
- Tagging during head start: BLOCKED
- Runner cannot receive Tagger coordinates: PASS
- Tagger has no live Runner tracking before snapshot: PASS
- Ghost activation without earned charge: BLOCKED
- Single team member can progress the shared Extra Health quest: PASS
- Extra Health award rotates the team secret code: PASS
- Old team code is rejected after rotation: PASS
- Extra Health penalty scales with game duration (10/30/60 min): PASS
- Frontend JavaScript syntax check: PASS
- Backend JavaScript syntax check: PASS

A full physical outdoor GPS/Google Maps test still requires real phones with location permission and network access; that cannot be simulated faithfully by the local API tests.

## Run

```bash
cd irl-tag/backend
node server.js
```

Open the server URL in a browser. For phones outside the laptop's local network, deploy the backend to a public HTTPS host/tunnel.

## v4 hard-test status
See `HARD_TEST_REPORT_V4.md` for the full regression report. The backend/API hard test suite and frontend static checks pass.
