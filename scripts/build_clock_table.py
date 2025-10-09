#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


KEEP_PLAY_TYPES = {
	"run",
	"pass",
	"qb_spike",
	"qb_kneel",
	"field_goal",
	"punt",
}


def parse_args() -> argparse.Namespace:
	p = argparse.ArgumentParser(description="Build empirical clock table from nflfastR PBP CSVs")
	p.add_argument("--pbp", nargs='+', required=True, help="Paths to play_by_play_*.csv files")
	p.add_argument("--out", required=True, help="Output JSON path")
	return p.parse_args()


def main() -> None:
	args = parse_args()
	dfs = []
	for path in args.pbp:
		df = pd.read_csv(path, low_memory=False)
		df = df[[
			"game_id",
			"qtr",
			"game_seconds_remaining",
			"play_type",
			"timeout_team",
		]].copy()
		dfs.append(df)
	df = pd.concat(dfs, ignore_index=True)
	# Filter to relevant plays
	df = df[df["play_type"].isin(KEEP_PLAY_TYPES)].copy()
	# Compute half_seconds_remaining
	df["half_seconds_remaining"] = df.apply(lambda r: r["game_seconds_remaining"] - (1800 if r["qtr"] >= 3 else 0), axis=1)
	# Sort by game and half descending (clock runs down)
	df["half"] = df["qtr"].apply(lambda q: 1 if q in (1, 2) else 2)
	df.sort_values(["game_id", "half", "half_seconds_remaining"], ascending=[True, True, False], inplace=True)
	# Compute delta seconds to next play in same game/half
	df["next_half_sec"] = df.groupby(["game_id", "half"][0:2])["half_seconds_remaining"].shift(-1)
	df["delta_sec"] = df["half_seconds_remaining"] - df["next_half_sec"]
	# Keep sane deltas
	df = df[(df["delta_sec"].notna()) & (df["delta_sec"] >= 0) & (df["delta_sec"] <= 120)].copy()
	# Features for grouping
	df["sec_bin"] = (df["half_seconds_remaining"] // 5).astype(int)
	df["has_timeout"] = (~df["timeout_team"].isna()).astype(int)
	# Aggregate mean/std count
	agg = df.groupby(["play_type", "sec_bin", "has_timeout"]).agg(
		mean=("delta_sec", "mean"),
		std=("delta_sec", "std"),
		n=("delta_sec", "size"),
	).reset_index()
	agg["mean"] = agg["mean"].fillna(24.0)
	agg["std"] = agg["std"].fillna(6.0)
	out = {
		"meta": {"sec_bin_width": 5},
		"stats": agg.to_dict(orient="records"),
	}
	Path(args.out).parent.mkdir(parents=True, exist_ok=True)
	with open(args.out, "w") as f:
		json.dump(out, f)


if __name__ == "__main__":
	main()
