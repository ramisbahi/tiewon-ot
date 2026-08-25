# TieWon rebuild audit

## Executive finding

The original project was not a deployable probability product. It was a research simulator, several overlapping dashboards, and multiple scraping experiments bundled together. The live dashboard frequently fell back to a random heuristic, then mislabeled `P(overtime) × 0.07` as “tie probability.”

TieWon v2 reduces the system to:

1. a reproducible offline training pipeline;
2. compact calibrated tie-specific and three-way outcome models that run in the browser;
3. a live scoreboard adapter; and
4. one responsive website with a preset/custom scenario simulator and empirical Monte Carlo cross-check.

## Model audit

| Legacy behavior | Problem | Replacement |
| --- | --- | --- |
| Hand-tuned expected-points buckets chose punts, turnovers, first downs, field goals, and touchdowns. | The transitions were not fitted as a coherent model and could not be validated as probabilities. | A gradient-boosted classifier learns the probability of reaching overtime directly from historical game states. |
| A “first down” always gained at least the yards-to-go. | It artificially extended drives and distorted field position and clock usage. | Historical state/outcome relationships are learned from actual snaps. |
| Timeouts were inputs but were never consumed by the simulator. | Late-game clock behavior was structurally wrong. | Timeouts enter the trained model as observed state features. |
| Field-goal and touchdown rates received hand-written final-two-minute boosts. | The model was tuned toward expected-looking outputs rather than held-out accuracy. | Final-five-minute states are preserved at full resolution and evaluated separately. |
| The default path depended on R packages and local precomputed tables. | Live calculations often failed outside the original machine. | Inference is a 69 KB JSON model with no Python or R server. |
| The fallback injected random variation into the same state. | Refreshing the page could change the answer without a play occurring. | Inference is deterministic for a given state. |
| The UI showed `P(OT) × 0.07` as “tie probability.” | It mixed two different events: regulation ending tied and overtime also ending tied. | The primary metric is explicitly “Tied at 0:00.” A separate “Final draw” estimate is shown for regular-season games. |
| The closing spread and “use spread prior” configuration existed but did not affect the simulator. | The interface implied information the model ignored. | Unsupported inputs were removed. |
| Touchdowns were treated like ordinary scrimmage states. | A one-point margin is completely different when an extra point is still pending. | Pending kick and two-point tries are explicit states and are resolved before normal inference or simulation. |
| Isotonic calibration imposed a 6.3% floor on some late one-point leads. | It violated basic football score geometry; no included final-two-minute state at a one- or two-point margin reached overtime. | A tested, non-zero geometry cap preserves rare safety/conversion paths while preventing implausible late probabilities. |
| Scenario playback always reset to the first demo. | Other presets and custom inputs were cosmetic. | A deterministic current-state play engine advances whichever preset or custom scenario is selected. |

## Application audit

The old folder contained four server variants, three DraftKings service variants, a Streamlit UI, duplicated requirements files, Selenium discovery scripts, cached bytecode, installed package metadata, and a broken 493 MB virtual environment.

Problems removed:

- Streamlit and FastAPI had separate refresh loops and in-memory caches.
- ESPN timeouts were hard-coded to three when unavailable.
- CORS allowed every origin while credentials were enabled.
- DraftKings automation relied on brittle browser scraping.
- “Old,” “new,” “DK only,” and “restructured” files represented conflicting application paths.
- Generated Python bytecode and package metadata were committed.
- There was no useful experience when games were not live.

The rebuilt website has one runtime, one page, one live data adapter, no database, and no server-side model compute. The live board polls every 15 seconds. If there are no live events—or the feed is unavailable—the product remains fully usable in demo and simulator modes. The Monte Carlo engine resamples outcome and clock distributions fitted from 26,352 drives and yields between batches so the interface remains responsive.

## Validation

The model was evaluated with five-fold out-of-fold validation grouped by game. Grouping matters: snapshots from one game never appear in both the training and validation sides of a fold.

| Scope | Model | Brier ↓ | Log loss ↓ | ROC AUC ↑ |
| --- | --- | ---: | ---: | ---: |
| All states | TieWon v2 | 0.0547 | 0.2106 | 0.705 |
| All states | Legacy fallback | 0.0575 | 0.2246 | 0.662 |
| Final 5:00 | TieWon v2 | 0.0547 | 0.1855 | 0.885 |
| Final 5:00 | Legacy fallback | 0.0645 | 0.2289 | 0.807 |

The largest improvement is in the final five minutes: roughly 15% lower Brier error than the legacy fallback.

The separate three-way classifier was validated on the same game-grouped folds. It reaches 72.2% weighted accuracy overall and 84.0% in the final five minutes, with multiclass log loss of 0.626 overall and 0.401 late. Its late tie Brier score (0.0552) is slightly worse than the binary specialist (0.0547), so the product keeps the binary model as the headline tie estimate and uses the three-way model only for the regulation outcome split.

## Remaining limitations

- The model uses game state, not current player injuries, weather, kicker identity, or team-strength ratings.
- ESPN's public scoreboard endpoint has no product-level service guarantee; the site degrades to demo mode if it is unavailable.
- The historical classifiers stop at 0:00 in regulation, so their labels are invariant to the overtime rules in effect that season.
- Final win/loss/tie results come from a separate rule-aware simulation: legacy regular season through 2024, both teams guaranteed an opportunity in a 10-minute regular-season period from 2025 onward, and no draw in postseason.
- Monte Carlo disagreement is intentionally visible. Its confidence interval covers finite sampling error, not transition-model misspecification, team strength, injuries, or weather.
- Probabilities should be recalibrated after each season and monitored for rule or data-feed changes.

## Recommended next model iteration

Add team-strength priors available before kickoff, retrain after the complete 2026 season, and maintain a season-level calibration report. Those additions should be measured against the current grouped validation before they are shipped.
