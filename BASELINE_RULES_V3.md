# IRL Tag — Baseline Rules v3

This build implements the current agreed baseline for team quests and Extra Health.

## Team quests
- A quest belongs to the entire team.
- Any one member can activate/progress the team's quest.
- The reward is granted to the team, not the individual.
- The Extra Health quest remains an extreme, timed, multi-stage quest.

## Extra Health
- When the extreme quest is validated as complete, the team receives Extra Health.
- The server immediately rotates the team's secret code.
- The old code becomes invalid.
- The new code is shown only to the owning team.
- When a Tagger later enters the new code, the server consumes the Extra Health instead of eliminating the Runner team.
- The Tagger team receives a server-controlled movement penalty.
- Penalty scales with game duration: 10 minutes = 1 minute, 60 minutes = 5 minutes, proportional between those bounds.
- The penalty timer is stored on the server and cannot be reset by the client.

## Team codes
- Codes are 3-character human-shareable codes.
- Codes are unique within a game.
- Codes are secret until the Runner team chooses to share one after being physically caught.
