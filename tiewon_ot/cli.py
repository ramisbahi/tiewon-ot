from __future__ import annotations

import argparse

from .api import overtime_probability
from .state import LiveState, Possession
from .sim import SimulatorConfig, simulate_overtime_prob_parallel
from .submodels import EPDrivenDriveModel
from .adapters.precomputed import (
    PrecomputedEPProvider,
    PrecomputedFieldGoalModel,
    PrecomputedPatDecisionModel,
    PrecomputedTwoPointSuccessModel,
)


def parse_args() -> argparse.Namespace:
	p = argparse.ArgumentParser(description="Estimate live NFL P(OT) via regulation simulation")
	p.add_argument("--score-diff", type=int, required=True, help="Home - away score")
	p.add_argument("--quarter", type=int, required=True)
	p.add_argument("--clock", type=int, required=True, help="Seconds remaining in current quarter")
	p.add_argument("--possession", choices=["home", "away"], required=True)
	p.add_argument("--down", type=int, required=True)
	p.add_argument("--distance", type=int, required=True)
	p.add_argument("--yardline", type=int, required=True, help="Yards from own goal line (1-99)")
	p.add_argument("--home-timeouts", type=int, required=True)
	p.add_argument("--away-timeouts", type=int, required=True)
	p.add_argument("--home-two-pt-available", type=int, default=1)
	p.add_argument("--away-two-pt-available", type=int, default=1)
	p.add_argument("--spread", type=float, default=0.0, help="Home closing spread (home negative when favored)")
	p.add_argument("--sims", type=int, default=50000)
	p.add_argument("--seed", type=int, default=None)
	p.add_argument("--workers", type=int, default=0, help="Parallel workers; 0 disables parallelism")
	p.add_argument("--progress", action="store_true", help="Show progress, ETA, and final duration")
	p.add_argument("--precomputed", action="store_true", help="Use precomputed Parquet tables instead of R adapters")
	p.add_argument("--calibrated", action="store_true", help="Apply isotonic calibration (requires fitted model)")
	p.add_argument("--shrink-naive", action="store_true", help="Apply late-game shrinkage toward naive no-score model")
	return p.parse_args()


def main() -> None:
	args = parse_args()
	state = LiveState(
		score_diff=args.score_diff,
		quarter=args.quarter,
		seconds_remaining=args.clock,
		possession=Possession.HOME if args.possession == "home" else Possession.AWAY,
		down=args.down,
		distance=args.distance,
		yardline_own=args.yardline,
		timeouts_home=args.home_timeouts,
		timeouts_away=args.away_timeouts,
		home_two_pt_available=bool(args.home_two_pt_available),
		away_two_pt_available=bool(args.away_two_pt_available),
		closing_spread=args.spread,
	)
	cfg = SimulatorConfig()
	if args.precomputed:
		# Swap in precomputed providers to avoid R overhead entirely
		cfg.drive = EPDrivenDriveModel(ep_provider=PrecomputedEPProvider())
		cfg.fg = PrecomputedFieldGoalModel()
		cfg.pat_decider = PrecomputedPatDecisionModel()
		cfg.two_pt_model = PrecomputedTwoPointSuccessModel()
	if args.workers and args.workers > 0:
		p = simulate_overtime_prob_parallel(state, num_simulations=args.sims, workers=args.workers, random_seed=args.seed, config=cfg, progress=args.progress)
	else:
		p = overtime_probability(state, num_simulations=args.sims, random_seed=args.seed, config=cfg, progress=args.progress)
	print(f"P(OT)={p:.5f}")


if __name__ == "__main__":
	main()
