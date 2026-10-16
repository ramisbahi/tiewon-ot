## Significant standalone alerts
Every post is standalone; the worker never supplies an X reply parent. Kickoff, initial tracking, quarter-end and halftime posts are disabled. Existing receipts and probability snapshots remain intact.

Q4 overtime-probability crossings above 20%, 50%, 75%, and 90% still alert once per milestone. A regulation final recap only closes a game that actually triggered a Q4 milestone alert; quiet games stay quiet. OT entry, OT final-tie thresholds, confirmed OT finals and huge tie celebrations are unchanged.

Final recaps report peak observed live tie and pre-OT forecasts, excluding known outcomes and automatic OT certainty.

### Welcome post
From `web/`, run `npm run bot:welcome` for a dry-run preview. With the existing four OAuth credentials and `BOT_LIVE=true`, the same command sends the welcome once, using the durable live ledger. It verifies the configured account first. The welcome describes TieWon and links to https://tiewon.sbahirami.chatgpt.site. This command does not start the continuous worker.

The welcome must never be sent automatically by tests, builds or deployments. Tests use mocked X requests and no credentials.

---

# @NFL_TieWon live bot

An independent Node worker reuses the website's ESPN adapter and calibrated regulation-tie model. It does not need an open browser or change the website's deployment. Run it on an always-on Docker host with a persistent volume; deploying the website alone does not run this process.

## Posting behavior

- Poll ESPN every **15 seconds**, including games crossing UTC midnight.
- No kickoff, initial tracking, halftime or quarter-end posts.
- In **Q4**, alert when the probability of reaching overtime is strictly above **20%, 50%, 75%, 90%**.
- Announce provider-confirmed **OVERTIME!** once, even without an earlier forecast or complete field data.
- During regular-season **OT**, switch to the probability of a **final tie**, using the same four milestones. Playoff games cannot finish tied.
- Post the confirmed final: tie, OT winner, or regulation winner only after a Q4 milestone alert.
- Publish every update as a separate standalone post. Each milestone is sent once per game/phase; a dip and recrossing do not repeat it. A jump over several levels produces one message listing those levels.
- Forecast budget: 128 per UTC day by default. Confirmed OT/final posts bypass this budget. X errors, account access, and uncertain delivery can still delay or block any post.
- Skip preseason/demo forecasts. Incomplete field data, pending touchdowns/tries, and unconfirmed 0:00 states produce gaps rather than guesses. OT forecasts additionally require a consistent summary drive history.

The maximum natural game sequence is four Q4 forecasts, one OT confirmation, four OT forecasts, and one final; a high opening OT probability can combine milestones into the OT announcement. Games first seen after finishing receive a final only if they reached OT or triggered a Q4 milestone alert.

Both probabilities are estimates. Regulation OT probability uses the calibrated historical model. Final-tie probability in regulation multiplies it by a **7.05% fresh-OT tie rate**, supplied by the user from a friend's simulation on 2026-10-16. The external simulation code and assumptions were not supplied or independently verified. Calibration provenance is in `web/lib/ot-calibration.json`. The historical 2025 cohort remains unchanged in `web/lib/ot-baseline.json` (1 tie / 14 OT games); it is not the source of the new 7.05% estimate. Recorded historical forecasts retain their original values and model versions. In OT, simulation starts at the actual score, clock, field state and completed possessions, with importance weights on complete futures calibrated to the joint distribution of first-drive outcome and final tie. Opening TD/FG/no-score weights are 21.5%/18.2%/60%, normalized by 99.7%; corresponding tie rates are 0.2%/12%/8%. Their weighted mean is 7.0481444333%. These are averages across simulated first drives, not flat forecasts for every subsequent state. With missing opening-drive history in old/manual sudden-death states, the model falls back to the overall odds-intercept calibration. A responding touchdown against an opening touchdown chooses a two-point try 90% of the time; conversion success is sampled separately. This strategy assumption remains user-specified. The new calibration does not independently validate live-state predictions. Postseason final-tie probability remains zero.

Research review (2026-10-12): the often-cited **11.2%** is from Martin, Timmons and Powell's [2018 Markov-chain paper](https://journals.sagepub.com/doi/10.3233/JSA-170198), modeling the 2017 move to ten-minute modified sudden death. It is not an estimate fitted to the 2025 mandatory-response rules or this bot's 90% responding-TD two-point strategy. Also, the [56.8% statistic](https://www.espn.com/nfl/story/_/id/44029502/nfl-considering-changes-regular-season-rules) describes receiving teams' eventual OT win rate, not first-possession endings. Neither claim justifies replacing the baseline with 11–12%. Keep the dated cohort and historical forecasts unchanged until a separately versioned calibration uses a complete, verified new-rules sample; do not select only tie games for updating it.

## Shared probability history

Every observed real game state is saved to local SQLite, including below-threshold states and periods when posting is paused. Final results use stable identities, so repeated final polls do not flood the chart. Fixture replays always use an in-memory database and cannot enter the upload queue.

The website uses a shared D1 database (`DB`) for original timestamped snapshots and its game archive. Its server refresh also records observations while the page is open. To collect continuously with no viewers, run the always-on worker and configure:

- Site server secret `HISTORY_INGEST_SECRET`.
- Matching worker `BOT_HISTORY_TOKEN` and `BOT_HISTORY_URL=https://YOUR_SITE/api/history/ingest`.

The worker uploads batches of at most 100 snapshots, keeps failed uploads queued, and marks them uploaded only after acknowledgement. The endpoint requires the secret. Dry-run on **real ESPN games** can collect/upload history without X credentials; it still never posts to X. Neither deploying the website nor pushing this repository starts the always-on collector.

Saved rows contain both probabilities, the complete input state, model version, timestamp and provenance. They are never rescored after a model change. Charts expose both series, support inspecting individual moments, and remain available after the final. The board lists the latest 64 games; older recorded histories remain available at `/api/history?game=ESPN_GAME_ID`.

The included Patriots-Seahawks archive (September 9, 2026, Seattle local date) contains 179 **reconstructed** points from ESPN play-by-play. It is explicitly labeled and never sent to X. Its importer is idempotent and populates D1 from the bundled backfill on first archive access. To regenerate offline:

```bash
cd web
node --import tsx ../bot/backfill.ts ../bot/tests/fixtures/ne-sea-2026-summary.json lib/backfills/401872656.json
```

Reconstruction uses each play's start state, the previous play's score, timeouts tracked within each half, and ESPN wallclock timestamps. It does not use the eventual result to score earlier points. The backfill utility supports completed regulation and overtime games.

## Credentials

Use one X developer app with read/write permission and the four matching OAuth 1.0a credentials:

| Environment variable | X credential |
| --- | --- |
| `X_API_KEY` | App API key / consumer key |
| `X_API_SECRET` | App API key secret / consumer secret |
| `X_ACCESS_TOKEN` | User access token for @NFL_TieWon |
| `X_ACCESS_TOKEN_SECRET` | User access token secret |

Set read/write access before generating user tokens; regenerate them if permissions were changed. The app must have access and sufficient credits for the endpoints. The worker verifies `/2/users/me` against `X_EXPECTED_USERNAME` before any live post. Read-only verification does not prove write access; that is confirmed only by an actual post.

Put credentials in the host's secret environment or ignored `bot/.env`. Never paste them into source, Docker images, logs, or `NEXT_PUBLIC_*` variables. No supplied secrets are included in this repository.

Official references: [OAuth credentials](https://docs.x.com/fundamentals/authentication/oauth-1-0a/obtaining-user-access-tokens), [request signing](https://docs.x.com/fundamentals/authentication/oauth-1-0a/creating-a-signature), [create posts](https://docs.x.com/x-api/posts/create-post).

## Local verification (Node 22.13+; Docker uses Node 24)

From the repository root:

```bash
cp bot/.env.example bot/.env
chmod 600 bot/.env
cd web
npm ci
npm test
npx tsc -p ../bot/tsconfig.json
npm run bot:once
```

Dry-run is the default and requires no X credentials. It writes previews and a separate dry-run ledger; it never calls X. Zero eligible games produces an empty poll, not fake posts. To replay an ESPN-shaped fixture, use `npm run bot -- --fixture /absolute/path/scoreboard.json`; fixture event dates must be within 18 hours and fixture replay is prohibited in live mode.

After adding all four credentials to `bot/.env`:

```bash
npm run bot:check-auth
```

This checks the account without posting. `npm run bot` then continuously previews real game updates. Set `BOT_LIVE=true` in the host environment only when ready to publish.

To preview the connection-test message, run `npm run bot:test-post` in dry-run mode. After all four credentials are configured, publish one clearly labeled test post with:

```bash
BOT_LIVE=true npm run bot:test-post
```

The test verifies the account first, uses the same durable ledger and error handling as the worker, and suppresses repeat connection-test posts. It does not start continuous posting. Message: "TieWon bot connection test. This is a test post, not a live game prediction. #TieWon"

## Persistent deployment

On an always-on host with Docker Compose, from the repository root:

```bash
# First leave BOT_LIVE=false in bot/.env and inspect previews.
docker compose -f compose.bot.yml up -d --build
docker compose -f compose.bot.yml logs -f --tail=100 bot

# After setting BOT_LIVE=true in bot/.env, verify the account:
docker compose -f compose.bot.yml run --rm bot node --import tsx ../bot/run.ts --check-auth
docker compose -f compose.bot.yml up -d --force-recreate
```

The named `bot-state` volume preserves the SQLite ledger across restarts and rebuilds. Do not delete the volume or run live copies with separate ledgers: that loses deduplication. SQLite claims serialize concurrent publishers sharing the same file, including their forecast budgets and delivery pauses. Local Node runs use `.bot-state/` at the repository root; Docker uses its named volume. These are distinct ledgers, so use one live deployment only.

Stop publishing with `docker compose -f compose.bot.yml stop bot`. For code updates, pull the branch and run `docker compose -f compose.bot.yml up -d --build`. This configuration does not provision a server or schedule itself through GitHub Actions.

## Delivery failures and recovery

The ledger records a claim **before** sending. If X responds successfully, the post ID is saved. A timeout, HTTP 408/5xx, missing post ID, or process crash during sending leaves delivery uncertain and pauses **all** posting. The bot intentionally does not blindly retry these requests: X may already have published the post. This favors avoiding duplicates over guaranteed delivery; exactly-once delivery is not promised.

HTTP 429 stores a cooldown of at least 15 minutes (or X's later reset), then recomputes candidates from a fresh scoreboard. Other definite 4xx rejections pause for at least one hour and report a configuration/access error. ESPN errors trigger bounded backoff without synthetic data. Poll and post logs provide process activity; monitor these on the host. No alerts are sent to other accounts.

Inspect the ledger using `npm run bot:status` locally, or:

```bash
docker compose -f compose.bot.yml exec bot node --import tsx ../bot/run.ts --status
```

For an uncertain post, stop the worker and inspect @NFL_TieWon's timeline. Resolve its ledger key to the actual X post ID if published, or `not-sent` only after confirming it was not published:

```bash
docker compose -f compose.bot.yml stop bot
docker compose -f compose.bot.yml run --rm bot node --import tsx ../bot/run.ts --status
docker compose -f compose.bot.yml run --rm bot node --import tsx ../bot/run.ts --resolve GAME_ID:KEY POST_ID
# Or replace POST_ID with not-sent after manual verification.
docker compose -f compose.bot.yml up -d
```

Local equivalents are `npm run bot:status` and `npm run bot:resolve -- GAME_ID:KEY POST_ID`. Use the same `BOT_LIVE` and `BOT_DATABASE` as the worker. Resolution never posts immediately; the next poll reevaluates the current game state. Never resolve claims while a worker is actively publishing. Back up the volume with the bot stopped.

## Week 1 archive and OT simulator

The bundled 2026 Week 1 archive covers all 15 completed games: Patriots-Seahawks, Rams-49ers and all 13 Sunday games, including Saints-Lions OT. It contains 2,740 reconstructed snapshots. Monday Denver-Kansas City is excluded until final. The manifest and immutable model outputs are in `web/lib/backfills`; the original Patriots-Seahawks archive retains its original model version.

OT replay tracks earlier completed drives, resets timeouts on entering OT, and scores each play from its start state and the PREVIOUS play's score. No eventual drive/game result is used to estimate an earlier state. Missing wallclocks are interpolated and flagged. Some ESPN wallclocks are also incorrect or nonmonotonic; reconstructed charts use play order and retain raw timestamps in the API. When a full reconstruction exists, the chart shows that coherent series; any original live observations remain stored and accessible through the history API.

The index seeds each bundled game's confirmed final into D1. Selecting a game seeds its full history idempotently, without duplicating or recalculating published snapshots. To backfill the saved cohort:

```bash
cd web
node --import tsx ../bot/backfill-week.ts ../bot/tests/fixtures/week1-2026/scoreboard.json ../bot/tests/fixtures/week1-2026 lib/backfills
```

The original NE-SEA input is `bot/tests/fixtures/ne-sea-2026-summary.json`; copy it as `401872656.json` into the input directory only if rebuilding that missing archive from scratch. Reconstruction scripts are offline and never import the X publisher.

The simulator now exposes Q1/Q2/Q3/Q4/OT. OT offers opening, response and sudden-death stages, score/clock/field/timeout controls and validation. These are normal-snap states after conversions; pending tries are not selectable in the OT panel.

## Railway worker handoff

Use one always-on service from this branch, repository root `/`, Dockerfile `bot/Dockerfile`, image default start command, and a persistent volume at `/app/.bot-state` writable by UID 1000. Configure four X secrets, `BOT_LIVE=true`, `X_EXPECTED_USERNAME=NFL_TieWon`, `BOT_DATABASE=/app/.bot-state/live.sqlite`, and the history URL/token above. Disable sleeping and use one replica. Preserve the existing ledger when migrating a worker and stop the old copy first. Verify authenticated startup and recurring successful polls in host logs before describing the bot as live. A committed Docker configuration or successful X test does not establish that a worker is deployed.

## Kickoff and confirmed-tie celebration
Kickoff estimates are recorded for history but do not trigger tweets. At 0-0 in the first 90 seconds, its kickoff forecast uses an ESPN pregame spread captured before the scheduled start, paired with smoothed 2017-2025 nflverse OT rates by absolute-spread bucket. Quotes are persisted before kickoff and never replaced using an in-game line. If no valid pregame quote was recorded, the post explicitly uses the historical average. There are no late-join tracking posts. Keep the worker running before kickoff to collect quotes.

The fitted dataset has 2,383 regular-season games and 131 OT games. Buckets are <=3, >3 through 7, and >7 points, shrunk toward the league rate with 100 pseudo-games. A 2024-2025 holdout produces Brier 0.052011 versus 0.052106 for the flat rate: a small improvement, not strong calibration evidence. The final-tie forecast multiplies the OT estimate by the configured 7.05% fresh-OT simulation baseline; postseason final tie stays zero. Reproduce with `python modeling/train_pregame.py /path/to/nflverse-games.csv`. Provenance and validation are in `web/lib/pregame-baseline.json`.

Confirmed regular-season OT ties receive the full siren/confetti/trophy TieWatch celebration, including peak observed forecasts. A tied live score or a postseason game never triggers that celebration. Existing durable final keys prevent repeat celebrations.
