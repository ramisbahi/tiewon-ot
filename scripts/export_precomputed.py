#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import List

import numpy as np
import pandas as pd

# We rely on rpy2 to call R packages in batch once for export
from rpy2 import robjects as ro  # type: ignore
from rpy2.robjects.packages import importr  # type: ignore
from rpy2.robjects import pandas2ri  # type: ignore
from rpy2.robjects.conversion import localconverter  # type: ignore

import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

try:
	import fcntl  # type: ignore
except Exception:  # pragma: no cover
	fcntl = None  # type: ignore


def silence_r_console() -> None:
	try:
		from rpy2.rinterface_lib import callbacks as _cb  # type: ignore
		_cb.consolewrite_print = lambda x: None  # type: ignore
		_cb.consolewrite_warnerror = lambda x: None  # type: ignore
	except Exception:
		pass


def ensure_dirs(path: Path) -> None:
	path.mkdir(parents=True, exist_ok=True)


# ------------------------- EP Export (with optional parallel by quarter) -------------------------

def _build_ep_rows_for_quarter(q: int, dist_buckets: List[int], yard_buckets: List[int], sec_bins: List[int], sec_bin_width: int, dist_rep: dict[int, int], to_vals: List[int]) -> pd.DataFrame:
	rows: List[dict] = []
	for db in dist_buckets:
		for yb in yard_buckets:
			for sb in sec_bins:
				hsec = sb * sec_bin_width
				for to_off in to_vals:
					for to_def in to_vals:
						rows.append({
							"down": 1,  # placeholder; we'll duplicate for downs below after DataFrame creation
							"dist_b": db,
							"ydl_b": yb,
							"qtr": q,
							"sec_b": sb,
							"season": 2025,
							"ydstogo": 0,
							"yardline_100": int(min(99, yb)),
							"half_seconds_remaining": int(hsec),
							"posteam": "HOME",
							"defteam": "AWAY",
							"home_team": "HOME",
							"posteam_timeouts_remaining": int(to_off),
							"defteam_timeouts_remaining": int(to_def),
							"roof": "outdoors",
							"surface": "grass",
						})
	df = pd.DataFrame(rows)
	# Expand downs via repeat with representative ydstogo
	downs = [1, 2, 3, 4]
	dfs: List[pd.DataFrame] = []
	for d in downs:
		dfi = df.copy()
		dfi["down"] = d
		dfi["ydstogo"] = int(dist_rep[2 if d == 1 else 5])  # simple representative; actual distance used in dist bucket below
		dfs.append(dfi)
	df = pd.concat(dfs, ignore_index=True)
	# Override ydstogo per dist bucket representative
	dist_rep_series = df["dist_b"].map(dist_rep).astype(int)
	df["ydstogo"] = dist_rep_series
	return df


def _ep_quarter_worker(args: tuple[int, List[int], List[int], List[int], int, dict[int, int], List[int]]) -> pd.DataFrame:
	q, dist_buckets, yard_buckets, sec_bins, sec_bin_width, dist_rep, to_vals = args
	silence_r_console()
	im_dplyr = importr("dplyr")
	im_nflfastR = importr("nflfastR")
	df = _build_ep_rows_for_quarter(q, dist_buckets, yard_buckets, sec_bins, sec_bin_width, dist_rep, to_vals)
	calc_fun = ro.r("function(df) { nflfastR::calculate_expected_points(df)$ep }")
	chunk = 50000
	ep_vals = np.zeros(len(df), dtype=float)
	for start in range(0, len(df), chunk):
		end = min(len(df), start + chunk)
		with localconverter(ro.default_converter + pandas2ri.converter):
			rdf = ro.conversion.py2rpy(df.iloc[start:end].copy())
		res = calc_fun(rdf)
		ep_vals[start:end] = np.asarray(res, dtype=float)
	df["ep"] = ep_vals
	return df[["down", "dist_b", "ydl_b", "qtr", "sec_b", "posteam_timeouts_remaining", "defteam_timeouts_remaining", "ep"]].rename(columns={
		"posteam_timeouts_remaining": "to_off",
		"defteam_timeouts_remaining": "to_def",
	})


def export_ep(outdir: Path, sec_bin_width: int = 5, include_timeouts: bool = True, parallel_quarters: bool = True) -> None:
	print("Exporting EP table ...")
	dist_buckets = [2, 5, 10, 15, 99]
	dist_rep = {2: 2, 5: 4, 10: 8, 15: 13, 99: 18}
	yard_buckets = list(range(5, 100, 5))  # 5..99
	quarters = [1, 2, 3, 4]
	sec_bins = list(range(0, int((2 * 15 * 60) // sec_bin_width) + 1))  # 0..360
	to_vals = [0, 1, 2, 3] if include_timeouts else [0]
	start = time.perf_counter()
	dfs: List[pd.DataFrame] = []
	if parallel_quarters:
		with ProcessPoolExecutor(max_workers=min(4, len(quarters))) as ex:
			futs = [ex.submit(_ep_quarter_worker, (q, dist_buckets, yard_buckets, sec_bins, sec_bin_width, dist_rep, to_vals)) for q in quarters]
			for i, fut in enumerate(as_completed(futs), 1):
				dfs.append(fut.result())
				elapsed = time.perf_counter() - start
				pct = i / float(len(quarters))
				eta = (elapsed / max(pct, 1e-9)) * (1.0 - pct)
				print(f"[EP {int(pct*100):3d}%] elapsed {elapsed:.1f}s | eta {eta:.1f}s", file=sys.stderr)
	else:
		for i, q in enumerate(quarters, 1):
			dfs.append(_ep_quarter_worker((q, dist_buckets, yard_buckets, sec_bins, sec_bin_width, dist_rep, to_vals)))
			elapsed = time.perf_counter() - start
			pct = i / float(len(quarters))
			eta = (elapsed / max(pct, 1e-9)) * (1.0 - pct)
			print(f"[EP {int(pct*100):3d}%] elapsed {elapsed:.1f}s | eta {eta:.1f}s", file=sys.stderr)
	df = pd.concat(dfs, ignore_index=True)
	out = outdir / "ep_table.parquet"
	df = df.astype({"down": "int16", "dist_b": "int16", "ydl_b": "int16", "qtr": "int16", "sec_b": "int16", "to_off": "int16", "to_def": "int16"})
	print(f"{len(df):,} rows → {out}")
	df.to_parquet(out, index=False)
	print(f"Wrote {out}")


# ------------------------- FG Export -------------------------

def export_fg(outdir: Path) -> None:
	print("Exporting FG table ...")
	im_fastr = importr("fastrmodels")
	im_mgcv = importr("mgcv")
	# Kick distances 18..80
	kick_dists = list(range(18, 81))
	yardline_100 = [int(np.clip(k - 17, 1, 99)) for k in kick_dists]
	silence_r_console()
	pred_fun = ro.r("function(df) { m <- fastrmodels::fg_model; df$model_roof <- factor(df$model_roof, levels=m$xlevels$model_roof); df$era <- factor(df$era, levels=m$xlevels$era); mgcv::predict.gam(m, newdata=df, type='response') }")
	r_df = ro.DataFrame({
		"model_roof": ro.FactorVector(ro.StrVector(["outdoors"] * len(kick_dists))),
		"era": ro.FactorVector(ro.StrVector(["3"] * len(kick_dists))),
		"yardline_100": ro.FloatVector([float(y) for y in yardline_100]),
	})
	p = np.asarray(pred_fun(r_df), dtype=float)
	out = outdir / "fg_table.parquet"
	df = pd.DataFrame({"kick_dist": kick_dists, "p": p}).astype({"kick_dist": "int16"})
	print(f"{len(df):,} rows → {out}")
	df.to_parquet(out, index=False)
	print(f"Wrote {out}")


# ------------------------- PAT Decision Export (parallel by quarter) -------------------------

def _pat_quarter_worker(args: tuple[int, List[int], List[int], int]) -> pd.DataFrame:
	q, sec_bins_q, score_diffs, sec_bin_width = args
	# Heuristic logistic model for p_go (no R calls)
	# Coefficients (interpretable, smooth):
	beta0 = -0.4   # baseline slight bias toward kicking
	beta1 = -0.35  # more likely to go for 2 when trailing (score_diff negative)
	beta2 = 0.1    # slightly more aggression later in game (by quarter)
	beta3 = -0.5   # high seconds_remaining reduces go-for-2 (normalize by 900)
	beta4 = 0.1    # more timeouts on offense raises go-for-2
	beta5 = 0.1    # more timeouts on defense lowers go-for-2 (subtract below)
	timeouts = [0, 1, 2, 3]
	rows: List[dict] = []
	for sb in sec_bins_q:
		qsec = sb * sec_bin_width
		for sd in score_diffs:
			for to_off in timeouts:
				for to_def in timeouts:
					# logistic linear term
					x = (
						beta0
						+ beta1 * float(sd)
						+ beta2 * float(q)
						+ beta3 * float(qsec) / 900.0
						+ beta4 * float(to_off)
						- beta5 * float(to_def)
					)
					p = 1.0 / (1.0 + np.exp(-np.clip(x, -50.0, 50.0)))
					p = float(np.clip(p, 0.05, 0.95))
					rows.append({
						"qtr": int(q),
						"sec_b_qtr": int(sb),
						"score_differential": int(sd),
						"to_off": int(to_off),
						"to_def": int(to_def),
						"p_go": p,
					})
	df = pd.DataFrame(rows)
	return df


def export_pat_decision(outdir: Path, sec_bin_width: int = 5, parallel_quarters: bool = True) -> None:
	print("Exporting PAT decision table ...")
	quarters = [1, 2, 3, 4]
	sec_bins_q = list(range(0, int((15 * 60) // sec_bin_width) + 1))  # 0..180
	score_diffs = list(range(-15, 16))
	start = time.perf_counter()
	dfs: List[pd.DataFrame] = []
	if parallel_quarters:
		with ProcessPoolExecutor(max_workers=min(4, len(quarters))) as ex:
			futs = [ex.submit(_pat_quarter_worker, (q, sec_bins_q, score_diffs, sec_bin_width)) for q in quarters]
			for i, fut in enumerate(as_completed(futs), 1):
				dfs.append(fut.result())
				elapsed = time.perf_counter() - start
				pct = i / float(len(quarters))
				eta = (elapsed / max(pct, 1e-9)) * (1.0 - pct)
				print(f"[PAT {int(pct*100):3d}%] elapsed {elapsed:.1f}s | eta {eta:.1f}s", file=sys.stderr)
	else:
		for i, q in enumerate(quarters, 1):
			dfs.append(_pat_quarter_worker((q, sec_bins_q, score_diffs, sec_bin_width)))
			elapsed = time.perf_counter() - start
			pct = i / float(len(quarters))
			eta = (elapsed / max(pct, 1e-9)) * (1.0 - pct)
			print(f"[PAT {int(pct*100):3d}%] elapsed {elapsed:.1f}s | eta {eta:.1f}s", file=sys.stderr)
	df = pd.concat(dfs, ignore_index=True)
	df = df.astype({"qtr": "int16", "sec_b_qtr": "int16", "score_differential": "int16", "to_off": "int16", "to_def": "int16"})
	out = outdir / "pat_decision_table.parquet"
	print(f"{len(df):,} rows → {out}")
	df.to_parquet(out, index=False)
	print(f"Wrote {out}")


# ------------------------- 2PT Success Export -------------------------

def export_two_point(outdir: Path, sec_bin_width: int = 5) -> None:
	print("Exporting 2PT success table ...")
	# Heuristic logistic model (no R): varies smoothly with time and quarter
	quarters = [1, 2, 3, 4]
	sec_bins_h = list(range(0, int((2 * 15 * 60) // sec_bin_width) + 1))  # 0..360
	rows: List[dict] = []
	# Coefficients: center near 0.5, slight decrease with more time remaining, tiny quarter effect
	alpha0 = 0.0
	alpha_q = 0.03  # later quarters slightly higher
	alpha_t = -0.25 # earlier in half (more seconds remaining) slightly lower
	for q in quarters:
		for sb in sec_bins_h:
			hsec = int(sb * sec_bin_width)
			# Normalize time within half to [0,1] but cap at 900 (one quarter) for simplicity
			t_norm = min(900, hsec) / 900.0
			x = alpha0 + alpha_q * (q / 4.0) + alpha_t * t_norm
			p = 1.0 / (1.0 + np.exp(-np.clip(x, -50.0, 50.0)))
			p = float(np.clip(p, 0.35, 0.65))
			rows.append({
				"qtr": int(q),
				"half_seconds_remaining": hsec,
				"p_success": p,
			})
	df = pd.DataFrame(rows)
	df = df.assign(sec_b_half=(df["half_seconds_remaining"] // sec_bin_width).astype(int))[ ["qtr", "sec_b_half", "p_success"] ].astype({"qtr": "int16", "sec_b_half": "int16"})
	out = outdir / "two_point_table.parquet"
	print(f"{len(df):,} rows → {out}")
	df.to_parquet(out, index=False)
	print(f"Wrote {out}")


def main() -> None:
	parser = argparse.ArgumentParser(description="Export precomputed Parquet tables for EP, FG, PAT decision, 2PT success")
	parser.add_argument("--outdir", type=str, default=str(Path(__file__).resolve().parents[1] / "data"))
	parser.add_argument("--sec-bin-width", type=int, default=5)
	parser.add_argument("--no-parallel", action="store_true")
	args = parser.parse_args()
	outdir = Path(args.outdir)
	ensure_dirs(outdir)
	silence_r_console()
	np.random.seed(0)
	ro.r("set.seed(0)")
	parallel = not args.no_parallel
	export_ep(outdir, sec_bin_width=args.sec_bin_width, include_timeouts=True, parallel_quarters=parallel)
	export_fg(outdir)
	export_pat_decision(outdir, sec_bin_width=args.sec_bin_width, parallel_quarters=parallel)
	export_two_point(outdir, sec_bin_width=args.sec_bin_width)
	print("All tables exported.")


if __name__ == "__main__":
	main()
