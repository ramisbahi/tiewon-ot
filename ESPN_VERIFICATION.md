# ESPN feed verification — September 10, 2026

## Requests checked against real responses

| Endpoint | Evidence |
| --- | --- |
| `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20260909-20260910&limit=100` | HTTP 200; response date September 10, 2026, 18:03 UTC. Patriots at Seahawks (`401872656`) was final, period 4, Seattle 13–10. Rams–49ers was scheduled and correctly excluded. |
| `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401872656` | HTTP 200; confirmed final header, 19 drives and 179 play records with actual wallclock timestamps. Used for the labeled reconstructed archive. |
| `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20250928&limit=100` | HTTP 200; Packers at Cowboys (`401772921`) final 40–40, period 5. |
| `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401772921` | HTTP 200; OT opening Dallas drive began at 10:00 and ended with a field goal; Green Bay's response began at 4:40 and tied the game at 0:00. A truncated replay tests the live second-possession adapter. |

Public game references: [Patriots–Seahawks](https://www.espn.com/nfl/game/_/gameId/401872656/patriots-seahawks), [Packers–Cowboys](https://www.espn.com/nfl/game/_/gameId/401772921/packers-cowboys).

## Contract details verified

- Scoreboard status includes `period`, `clock`, and `type.state/name/completed`. Final states remain usable even when scrimmage details are missing.
- The summary competition's status can contain only `type`, with no clock or period. OT consistency checks therefore compare team scores and the current drive's last play clock with the scoreboard.
- Play fields include `start`, `end`, `period.number`, `clock.displayValue`, scores and `wallclock`. Scores are **after** the play, so backfill predictions pair the start field state with the **previous** play's score.
- Raw `yardLine` uses a fixed field orientation. Timeout records can report `yardsToEndzone=0` as a placeholder. The adapter/reconstruction uses possession text with team identity to orient field position.
- A completed summary has `drives.previous` and may have no `drives.current`. The live OT adapter requires an identified current drive, the full opening-OT sequence, consistent scores/possession, and a recent matching last play.
- ESPN's `winprobability` series is a win forecast, not a final-tie or OT probability. It is not used as either.

The fetcher requests yesterday through today in UTC, rejects failed/malformed responses and cache ages over 120 seconds, and applies an 18-hour kickoff window. Summary failures suppress OT probability estimates but do not suppress a scoreboard-confirmed OT announcement.

These are publicly accessible ESPN site endpoints, not a guaranteed or versioned developer API contract. Tests verify actual recent and archived responses plus controlled replays. No active overtime game was available during verification, so real-time OT latency and future schema stability have **not** been demonstrated.

## Overtime rules and model limits

Checked against Rule 16 of the [2026 NFL rulebook](https://operations.nfl.com/rules-officiating/2026-nfl-rulebook/): regular-season overtime lasts at most ten minutes, with an opportunity for both teams subject to the clock limit and defensive scoring exceptions. Equal scores after the relevant initial possessions lead to sudden death. Postseason games cannot end tied.

The new live-OT model tracks actual scores and completed possessions. Its score-transition tests cover opening touchdowns under old/current rules, equalizing touchdowns, field goals, a scoreless opening drive, defensive scores and clock expiry. Drive durations, residual-drive shortening, timeout effects, last-play overrun and late-game urgency remain approximations. Final-tie estimates are **not independently calibrated**; the regulation model's reported AUC/Brier score does not measure this simulation's quality.

## Backfill provenance

`bot/tests/fixtures/ne-sea-2026-summary.json` contains the relevant fields from the real ESPN response. `bot/backfill.ts` produces the 179 immutable points in `web/lib/backfills/401872656.json`. They carry `origin: reconstructed`, play IDs, provider wallclock times, reconstruction time, and model version. Missing or non-scrimmage states produce gaps. No replay post is sent to X.

The reconstructed Q4 OT probability peaks at approximately 43.8% at 0:26, before New England's last interception. This is a hindsight reconstruction of the current model on historical inputs, not evidence that the bot observed or published that probability during the game.
