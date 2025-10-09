#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
from pathlib import Path
from dataclasses import dataclass
from typing import List, Dict, Any

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

from tiewon_ot.state import LiveState, Possession
from tiewon_ot.sim import SimulatorConfig, simulate_once
from tiewon_ot.submodels import DriveOutcome


@dataclass
class GameLog:
	final_diff: int
	plays: int
	tds: int
	fgs: int
	home_pts: int
	away_pts: int
	q1_diff: int
	q2_diff: int
	q3_diff: int
	possessions_home: int
	possessions_away: int


def run_sims(n: int, no_prune: bool, seed: int | None) -> pd.DataFrame:
	rng = np.random.default_rng(seed)
	state0 = LiveState(
		score_diff=0,
		quarter=1,
		seconds_remaining=15*60,
		possession=Possession.HOME,
		down=1,
		distance=10,
		yardline_own=25,
		timeouts_home=3,
		timeouts_away=3,
	)
	cfg = SimulatorConfig()
	if no_prune:
		cfg.prune_no_time = False
	rows: List[Dict[str, Any]] = []
	for i in range(n):
		state = state0.model_copy(deep=True)
		plays = 0
		tds = 0
		fgs = 0
		home_pts = 0
		away_pts = 0
		q1_diff = 0
		q2_diff = 0
		q3_diff = 0
		poss_h = 0
		poss_a = 0
		# simulate with lightweight instrumentation by shadowing simulate_once internals
		local_cfg = cfg
		rng_i = np.random.default_rng(int(rng.integers(0, 2**32 - 1)))
		while True:
			if state.quarter > 4:
				break
			if state.quarter == 4 and state.seconds_remaining == 0:
				break
			if plays >= local_cfg.max_plays:
				break
			# capture quarter diffs at end of each quarter
			prev_quarter = state.quarter
			from tiewon_ot.sim import _apply_two_minute_boundary  # reuse helper
			# outcome
			event, payload = local_cfg.drive.next_event(state, rng_i)
			# possessions count
			if event in (DriveOutcome.PUNT, DriveOutcome.TURNOVER, DriveOutcome.FG_ATT, DriveOutcome.TD, DriveOutcome.END_HALF, DriveOutcome.FIRST_DOWN):
				if state.possession == Possession.HOME:
					poss_h += 1
				else:
					poss_a += 1
			# advance clock
			advance = min(local_cfg.clock.advance_seconds(state, rng_i, event), state.seconds_remaining)
			advance = _apply_two_minute_boundary(state, advance)
			state.seconds_remaining -= advance
			# apply outcomes
			if event == DriveOutcome.END_HALF:
				if state.quarter < 4:
					state.quarter += 1
					state.seconds_remaining = 15 * 60
					plays += 1
					continue
				else:
					break
			if state.seconds_remaining == 0:
				if state.quarter < 4:
					state.quarter += 1
					state.seconds_remaining = 15 * 60
				else:
					pass
			if event == DriveOutcome.TD:
				tds += 1
				is_home_off = state.possession == Possession.HOME
				state.score_diff = state.score_diff + 6 if is_home_off else state.score_diff - 6
				if is_home_off:
					home_pts += 6
				else:
					away_pts += 6
				# PAT: approximate with 1-point 95% chance
				if rng_i.random() < 0.95:
					state.score_diff = state.score_diff + 1 if is_home_off else state.score_diff - 1
					if is_home_off:
						home_pts += 1
					else:
						away_pts += 1
				# kickoff
				state.possession = Possession.AWAY if state.possession == Possession.HOME else Possession.HOME
				state.down = 1
				state.distance = 10
				state.yardline_own = 25
			elif event == DriveOutcome.FG_ATT:
				fgs += 1
				is_home = state.possession == Possession.HOME
				state.score_diff = state.score_diff + 3 if is_home else state.score_diff - 3
				if is_home:
					home_pts += 3
				else:
					away_pts += 3
				state.possession = Possession.AWAY if is_home else Possession.HOME
				state.down = 1
				state.distance = 10
				state.yardline_own = 25
			elif event == DriveOutcome.FIRST_DOWN:
				g = max(1, payload.get("yards", state.distance))
				state.down = 1
				state.distance = 10
				state.yardline_own = min(99, state.yardline_own + g)
			elif event in (DriveOutcome.PUNT, DriveOutcome.TURNOVER):
				net = int(rng_i.integers(35, 55))
				new_spot_old_perspective = max(1, min(99, state.yardline_own + net))
				state.possession = Possession.AWAY if state.possession == Possession.HOME else Possession.HOME
				state.down = 1
				state.distance = 10
				state.yardline_own = max(1, min(99, 100 - new_spot_old_perspective))
			plays += 1
			# quarter checkpoints
			if prev_quarter == 1 and state.quarter == 2:
				q1_diff = state.score_diff
			if prev_quarter == 2 and state.quarter == 3:
				q2_diff = state.score_diff
			if prev_quarter == 3 and state.quarter == 4:
				q3_diff = state.score_diff
			# prune-if rule
			if local_cfg.prune_no_time and state.quarter == 4 and state.seconds_remaining <= 5 and state.score_diff != 0:
				break
		rows.append({
			"final_diff": state.score_diff,
			"plays": plays,
			"tds": tds,
			"fgs": fgs,
			"home_pts": home_pts,
			"away_pts": away_pts,
			"q1_diff": q1_diff,
			"q2_diff": q2_diff,
			"q3_diff": q3_diff,
			"possessions_home": poss_h,
			"possessions_away": poss_a,
		})
	return pd.DataFrame(rows)


def main() -> None:
	parser = argparse.ArgumentParser(description="Run diagnostics over the simulator and produce CSV/plots")
	parser.add_argument("--n", type=int, default=1000)
	parser.add_argument("--no-prune", action="store_true")
	parser.add_argument("--outdir", type=str, default=str(Path("diagnostics_out").resolve()))
	args = parser.parse_args()
	outdir = Path(args.outdir)
	outdir.mkdir(parents=True, exist_ok=True)
	print(f"Running {args.n} sims (no_prune={args.no_prune})...")
	df = run_sims(args.n, args.no_prune, seed=123)
	csv_path = outdir / ("games_no_prune.csv" if args.no_prune else "games.csv")
	df.to_csv(csv_path, index=False)
	print(f"Wrote {csv_path}")
	# Summary
	df["total_pts"] = df["home_pts"] + df["away_pts"]
	print(df[["plays", "tds", "fgs", "total_pts", "final_diff"]].describe())
	# Plots
	plt.figure(figsize=(10,4))
	plt.subplot(1,2,1)
	df["final_diff"].hist(bins=31)
	plt.title("Final score differential")
	plt.subplot(1,2,2)
	df[["possessions_home", "possessions_away"]].sum(axis=1).hist(bins=31)
	plt.title("Total possessions (both teams)")
	plt.tight_layout()
	plot_path = outdir / ("hist_no_prune.png" if args.no_prune else "hist.png")
	plt.savefig(plot_path)
	print(f"Saved plots to {plot_path}")
	# Heuristics
	mean_plays = float(df["plays"].mean())
	mean_pts = float(df["total_pts"].mean())
	issues: List[str] = []
	if mean_plays < 130:
		issues.append("Low play count; clock model may be too fast")
	if mean_pts < 38:
		issues.append("Low scoring; drive model likely too conservative (few TD/FG)")
	if abs(float(df["final_diff"].mean())) > 10:
		issues.append("Score diff skew suggests imbalance in drive outcomes")
	print("\nDiagnostics summary:")
	print(f"- mean plays: {mean_plays:.1f}")
	print(f"- mean total points: {mean_pts:.1f}")
	print(f"- OT rate proxy (final_diff==0): {float((df['final_diff']==0).mean()):.4f}")
	for it in issues:
		print(f"* {it}")
	print("\nSuggested next tweaks:")
	print("- If plays low: scale EmpiricalClockModel means by 0.9–0.95")
	print("- If points low: raise FIRST_DOWN and FG_ATT probabilities in mid/high EP buckets by 10–20%")
	print("- If OT still low: loosen prune_no_time or add small endgame chaos (timeouts, penalties)")


if __name__ == "__main__":
	main()
