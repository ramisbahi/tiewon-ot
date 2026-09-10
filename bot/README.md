# @NFL_TieWon live bot

An independent Node worker reuses the website's ESPN adapter and calibrated regulation-tie model. It does not need an open browser or change the website's deployment. Run it on an always-on Docker host with a persistent volume; deploying the website alone does not run this process.

## Posting behavior

- Poll ESPN every **15 seconds**, including games crossing UTC midnight.
- In **Q4**, alert when the probability of reaching overtime is strictly above **20%, 50%, 75%, 90%**.
- Announce provider-confirmed **OVERTIME!** once, even without an earlier forecast or complete field data.
- During regular-season **OT**, switch to the probability of a **final tie**, using the same four milestones. Playoff games cannot finish tied.
- Post the confirmed final: tie, OT winner, or regulation winner for a game previously followed.
- Keep each game's updates in one reply chain. Each milestone is sent once per game/phase; a dip and recrossing do not repeat it. A jump over several levels produces one message listing those levels.
- Forecast budget: 128 per UTC day by default. Confirmed OT/final posts bypass this budget. X errors, account access, and uncertain delivery can still delay or block any post.
- Skip preseason/demo forecasts. Incomplete field data, pending touchdowns/tries, and unconfirmed 0:00 states produce gaps rather than guesses. OT forecasts additionally require a consistent summary drive history.

There are no periodic low-value updates between milestones. The maximum natural game sequence is four Q4 forecasts, one OT confirmation, four OT forecasts, and one final; a high opening OT probability can combine milestones into the OT announcement. Games first seen after finishing receive a final only if they reached OT or were previously followed.

Both probabilities are estimates. Regulation OT probability uses the calibrated historical model. Final-tie probability in regulation multiplies it by a team-neutral simulated fresh-OT draw rate. In OT, simulation starts at the actual score, clock, field state and completed possessions. This new residual-drive approximation is **not separately calibrated**; the regulation model's validation statistics do not validate final-tie probabilities.

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

Reconstruction uses each play's start state, the previous play's score, timeouts tracked within each half, and ESPN wallclock timestamps. It does not use the eventual result to score earlier points. This backfill utility currently supports completed regulation games only.

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
