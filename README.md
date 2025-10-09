# tiewon-ot

Accurate live probability of overtime (P(OT)) for NFL games via regulation simulation.

## What it does

- Defines a live game state (score/time/possession/downs/TOs/yardline/team strength)
- Reuses existing models where possible (fg_model, ep_model from fastrmodels)
- Runs a Monte Carlo simulation of the rest of regulation and estimates P(OT)
- Provides a CLI and Python API; optional calibration and late-game shrinkage

## Install

```bash
pip install -e .
# Optional for R adapters
pip install rpy2
# In R, install dependencies
# install.packages(c("fastrmodels", "nfl4th", "nflfastR", "mgcv", "dplyr"))
```

## CLI

```bash
tiewon-ot --score-diff -3 --quarter 4 --clock 120 --possession home --down 3 --distance 6 --yardline 42 --home-timeouts 2 --away-timeouts 1 --home-two-pt-available 1 --away-two-pt-available 1 --spread -2.5 --sims 50000 --fg-provider fastr --shrink-naive --workers 8
```

## Python API

```python
from tiewon_ot.api import overtime_probability
from tiewon_ot.state import LiveState, Possession

state = LiveState(
    score_diff=-3,  # home - away
    quarter=4,
    seconds_remaining=120,
    possession=Possession.HOME,
    down=3,
    distance=6,
    yardline_own=42,
    timeouts_home=2,
    timeouts_away=1,
    home_two_pt_available=True,
    away_two_pt_available=True,
    closing_spread=-2.5,
)

p_ot = overtime_probability(state, num_simulations=100000, random_seed=1)
print(p_ot)
```

## Architecture

```mermaid
graph TD
  A[CLI / API input<br/>LiveState] --> B[Simulator<br/>simulate_overtime_prob / parallel]
  B --> C{Monte Carlo loop}
  C -->|draw next event| D[DriveModel<br/>EPDrivenDriveModel]
  D -->|event informs| E[ClockModel<br/>EmpiricalClockModel<br/>advance_seconds]
  C -->|advance clock| E
  D -->|FG_ATT| F[FieldGoalModel<br/>R fastrmodels fg_model or Precomputed<br/>late-Q4 distance sampling when in range]
  D -->|TD| G1[Add 6 points<br/>set pat_pending]
  G1 --> G[PAT Decision<br/>Inline heuristic football rules]
  G -->|2-pt attempt| H[TwoPtSuccess<br/>Precomputed two_point_table.parquet default<br/>R cp_model fallback]
  G -->|XP attempt| F2[XP via FG model at 33 yd]
  H --> G2[apply result; clear pat_pending]
  F2 --> G2
  G2 --> D2[Kickoff / possession flip]
  E --> I[data/clock_table.json]
  D --> J[EP Provider<br/>R nflfastR calculate_expected_points<br/>Precomputed ep_table.parquet]
  C -->|stop when 0:00| K{final diff == 0?}
  K -->|yes| L[record 1]
  K -->|no| M[record 0]
  L --> N[P(OT) = mean records]
  M --> N

  subgraph Config / Policies
    O[RuleEra]
    P[Workers / seeds]
    Q[precomputed, progress flags]
    R[Late-Q4 tuning non-tie modest boosts]
    S[Diagnostics: late_game_metrics.csv]
  end

  B -. uses .-> O
  B -. uses .-> P
  B -. flags .-> Q
  B -. tuning .-> R
  B -. logs .-> S
```

### Component notes

- Simulator: Monte Carlo of remaining regulation; returns mean(tied at 0:00).
- DriveModel: EP-driven transitions; calibrated bucket mapping; late-game FG/TD boost only when not tied (modest).
- ClockModel: event-conditioned empirical seconds-per-play from `data/clock_table.json`, with late-Q4 scaling.
- FG: R `fastrmodels::fg_model` (default) or precomputed `fg_table.parquet`; late-Q4 realistic distance sampling when in range; mild chip-shot protection only in final 2:00.
- EP: `nflfastR::calculate_expected_points` or precomputed `ep_table.parquet`.
- PAT decision: Inline heuristic based on score differential and time/game context (no R dependency); no precomputed table required.
- 2PT success: Precomputed `two_point_table.parquet` by default; R fallback available.
- Parallel: chunked per-worker RNG seeds for throughput and reproducibility; `--progress` prints ETA/elapsed.
- Diagnostics: `scripts/diagnostics.py` writes CSV + plots; simulator logs late-Q4 metrics to `diagnostics_out/late_game_metrics.csv`.

## R adapter

- Field goal model: `tiewon_ot.adapters.r_fastr.RFastRFieldGoalModel` wraps `fastrmodels::fg_model` via rpy2.
- Expected points provider: `tiewon_ot.adapters.r_fastr.RFastREPProvider` wraps `nflfastR::calculate_expected_points`.
- PAT decision: `tiewon_ot.adapters.r_fastr.RFastRPatDecisionModel` wraps `nfl4th::add_2pt_probs` to compare win probabilities.

## Notes

- This repo scaffolds a controllable sim; bring your own historical pbp to calibrate.
- Era/rule splits and reliability tooling included.
