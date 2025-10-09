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
  D -->|event informs| E[ClockModel<br/>EmpiricalClockModel<br/><i>advance_seconds(state, rng, event)</i>]
  C -->|advance clock (condition on event)| E
  D -->|FG_ATT| F[FieldGoalModel<br/>R fastrmodels::fg_model or<br/>Precomputed fg_table.parquet]
  D -->|TD| G1[Add 6 points<br/>set pat_pending]
  G1 --> G[PAT Decision<br/>R nfl4th::add_2pt_probs or<br/>Precomputed pat_decision_table.parquet (p_go)]
  G -->|2-pt attempt| H[TwoPtSuccess<br/>R fastrmodels::cp_model or<br/>Precomputed two_point_table.parquet]
  G -->|XP attempt| F2[XP via FG model at 33 yd]
  H --> G2[apply result; clear pat_pending]
  F2 --> G2
  G2 --> D2[Kickoff / possession flip]
  E --> I[data/clock_table.json<br/>O(1) indexed bins]
  D --> J[EP Provider<br/>R nflfastR::calculate_expected_points or<br/>Precomputed ep_table.parquet]
  C -->|stop when 0:00| K{final diff == 0?}
  K -->|yes| L[record 1]
  K -->|no| M[record 0]
  L --> N[P(OT) = mean(records)]
  M --> N

  subgraph External Data/Models
    I
    J
    F
    G
    H
    X1[ep_table.parquet]
    X2[fg_table.parquet]
    X3[pat_decision_table.parquet]
    X4[two_point_table.parquet]
  end

  subgraph Config/Policies
    O[RuleEra 2012/2022/2025]
    P[Parallel workers / seeds]
    Q[Optional snapshot logging]
    R[--precomputed to use parquet<br/>--progress for ETA/elapsed]
  end

  B -. uses .-> O
  B -. uses .-> P
  B -. optional .-> Q
  B -. flags .-> R
```

### Component notes

- Simulator: Monte Carlo of remaining regulation; returns mean(tied at 0:00).
- DriveModel: EP-driven transitions; robust bucket mapping; late-game 4th-down FG shortcut.
- ClockModel: event-conditioned empirical seconds-per-play from `data/clock_table.json` (e.g., punt vs pass vs FG vs turnover), built via `scripts/build_clock_table.py`.
- FG: `fastrmodels::fg_model` with proper factor levels (`model_roof`, `era`, `yardline_100`) via `mgcv::predict.gam`; or precomputed `fg_table.parquet`.
- EP: `nflfastR::calculate_expected_points` on a minimally-complete pbp row; or precomputed `ep_table.parquet` (keys: down × distance_bucket × yardline_bucket(5) × quarter × half_sec_bin(5s) × timeouts_off/def).
- PAT decision: `nfl4th::add_2pt_probs` (uses stable logistic of `wp_go2 - wp_go1`); or precomputed `pat_decision_table.parquet` storing `p_go` aggregated over team/yardline/KO grids into (qtr, qtr_sec_bin, score_diff, timeouts_off/def).
- 2PT success: `fastrmodels::cp_model`; or precomputed `two_point_table.parquet` (keys: quarter × half_sec_bin(5s)).
- Parallel: chunked per-worker RNG seeds for throughput and reproducibility; `--progress` prints ETA/elapsed to stderr.
- Precompute tables with `scripts/export_precomputed.py` (supports progress, parallel by quarter, and row-count prints).

## R adapter

- Field goal model: `tiewon_ot.adapters.r_fastr.RFastRFieldGoalModel` wraps `fastrmodels::fg_model` via rpy2.
- Expected points provider: `tiewon_ot.adapters.r_fastr.RFastREPProvider` wraps `nflfastR::calculate_expected_points`.
- PAT decision: `tiewon_ot.adapters.r_fastr.RFastRPatDecisionModel` wraps `nfl4th::add_2pt_probs` to compare win probabilities.

## Notes

- This repo scaffolds a controllable sim; bring your own historical pbp to calibrate.
- Era/rule splits and reliability tooling included.
