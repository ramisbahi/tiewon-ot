#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import pickle
from pathlib import Path

import numpy as np
import pandas as pd

from tiewon_ot.state import LiveState, Possession
from tiewon_ot.sim import SimulatorConfig
from tiewon_ot.api import overtime_probability
from tiewon_ot.metrics import brier_score, reliability_by_buckets
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression


def parse_args() -> argparse.Namespace:
	p = argparse.ArgumentParser(description="Calibrate P(OT) vs historical snapshots")
	p.add_argument("--snapshots", type=str, required=True, help="CSV with snapshots and OT labels")
	p.add_argument("--outdir", type=str, required=True)
	p.add_argument("--sims", type=int, default=20000)
	p.add_argument("--seed", type=int, default=1)
	p.add_argument("--fg-provider", choices=["simple", "fastr"], default="simple")
	p.add_argument("--drive-model", choices=["ep", "simple"], default="ep")
	return p.parse_args()


def row_to_state(row: pd.Series) -> LiveState:
	return LiveState(
		score_diff=int(row.score_diff),
		quarter=int(row.quarter),
		seconds_remaining=int(row.seconds_remaining),
		possession=Possession.HOME if row.possession == "home" else Possession.AWAY,
		down=int(row.down),
		distance=int(row.distance),
		yardline_own=int(row.yardline_own),
		timeouts_home=int(row.timeouts_home),
		timeouts_away=int(row.timeouts_away),
		home_two_pt_available=bool(row.home_two_pt_available),
		away_two_pt_available=bool(row.away_two_pt_available),
		closing_spread=float(row.closing_spread),
	)


def main() -> None:
	args = parse_args()
	outdir = Path(args.outdir)
	outdir.mkdir(parents=True, exist_ok=True)
	df = pd.read_csv(args.snapshots)
	cfg = SimulatorConfig()
	if args.fg_provider == "fastr":
		from tiewon_ot.adapters.r_fastr import RFastRFieldGoalModel
		cfg.fg = RFastRFieldGoalModel()
	if args.drive_model == "ep":
		from tiewon_ot.adapters.r_fastr import RFastREPProvider
		from tiewon_ot.submodels import EPDrivenDriveModel
		cfg.drive = EPDrivenDriveModel(ep_provider=RFastREPProvider())

	rng = np.random.default_rng(args.seed)
	p_preds = []
	y_true = []
	for _, row in df.iterrows():
		state = row_to_state(row)
		p = overtime_probability(state, num_simulations=args.sims, random_seed=int(rng.integers(0, 2**32 - 1)), config=cfg)
		p_preds.append(p)
		y_true.append(int(row.ot_label))
	p_preds = np.array(p_preds)
	y_true = np.array(y_true)

	# Raw metrics
	brier = brier_score(y_true, p_preds)
	reliab = reliability_by_buckets(y_true, p_preds, num_buckets=10)
	with open(outdir / "metrics.json", "w") as f:
		json.dump({
			"brier": brier,
			"reliability": {
				"edges": reliab.bucket_edges.tolist(),
				"mean_pred": reliab.bucket_mean_pred.tolist(),
				"mean_true": reliab.bucket_mean_true.tolist(),
				"counts": reliab.bucket_counts.tolist(),
			}
		}, f, indent=2)

	# Isotonic calibration
	iso = IsotonicRegression(out_of_bounds="clip")
	iso.fit(p_preds, y_true)
	with open(outdir / "calibrator_isotonic.pkl", "wb") as f:
		pickle.dump(iso, f)

	# Platt scaling
	platt = LogisticRegression(max_iter=1000)
	platt.fit(p_preds.reshape(-1, 1), y_true)
	with open(outdir / "calibrator_platt.pkl", "wb") as f:
		pickle.dump(platt, f)

	print(json.dumps({"brier": brier}, indent=2))


if __name__ == "__main__":
	main()
