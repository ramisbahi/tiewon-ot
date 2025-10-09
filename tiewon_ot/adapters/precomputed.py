from __future__ import annotations

from dataclasses import dataclass, field
from typing import Tuple, Dict, Any, Optional

import os
import math
import pandas as pd

from ..state import LiveState, Possession
from ..submodels import FieldGoalModel


def _half_seconds_remaining(qtr: int, qtr_seconds: int) -> int:
	return int(qtr_seconds + (900 if qtr in (1, 3) else 0))


def _sec_bin_half(hsec: int, width: int = 5) -> int:
	return int(hsec // width)


def _sec_bin_qtr(qtr_seconds: int, width: int = 5) -> int:
	return int(qtr_seconds // width)


def _distance_bucket(distance: int) -> int:
	# Buckets: 1-2, 3-5, 6-10, 11-15, 16+
	if distance <= 2:
		return 2
	if distance <= 5:
		return 5
	if distance <= 10:
		return 10
	if distance <= 15:
		return 15
	return 99


def _yardline_bucket(yardline_100: int) -> int:
	# 5-yard buckets: [1-5], [6-10], ..., [96-99]
	clamped = max(1, min(99, int(yardline_100)))
	return int(math.ceil(clamped / 5.0) * 5)


@dataclass
class PrecomputedEPProvider:
	path: Optional[str] = None
	_index_short: Dict[Tuple[int, int, int, int, int], float] = field(default_factory=dict)
	_index_with_to: Dict[Tuple[int, int, int, int, int, int, int], float] = field(default_factory=dict)

	def __post_init__(self) -> None:
		p = self.path or os.environ.get("EP_TABLE_PATH")
		if not p:
			proj_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
			p = os.path.join(proj_root, "data", "ep_table.parquet")
		if not os.path.exists(p):
			raise RuntimeError(f"EP parquet not found at {p}; run scripts/export_precomputed.py")
		df = pd.read_parquet(p)
		if {"to_off", "to_def"}.issubset(set(df.columns)):
			for _, row in df.iterrows():
				key = (
					int(row["down"]), int(row["dist_b"]), int(row["ydl_b"]),
					int(row["qtr"]), int(row["sec_b"]), int(row["to_off"]), int(row["to_def"])
				)
				self._index_with_to[key] = float(row["ep"])
		else:
			for _, row in df.iterrows():
				key = (int(row["down"]), int(row["dist_b"]), int(row["ydl_b"]), int(row["qtr"]), int(row["sec_b"]))
				self._index_short[key] = float(row["ep"])

	def expected_points(self, state: LiveState) -> float:
		hsec = _half_seconds_remaining(state.quarter, state.seconds_remaining)
		sec_b = _sec_bin_half(hsec)
		ydl100 = 100 - state.yardline_own
		to_off = int(state.timeouts_home if state.possession == Possession.HOME else state.timeouts_away)
		to_def = int(state.timeouts_away if state.possession == Possession.HOME else state.timeouts_home)
		key_short = (int(state.down), int(_distance_bucket(state.distance)), int(_yardline_bucket(ydl100)), int(state.quarter), int(sec_b))
		if self._index_with_to:
			key_with = (*key_short, int(to_off), int(to_def))
			return self._index_with_to.get(key_with, self._index_short.get(key_short, 0.0))
		return self._index_short.get(key_short, 0.0)


@dataclass
class PrecomputedFieldGoalModel(FieldGoalModel):
	path: Optional[str] = None
	_fg: Dict[int, float] = field(default_factory=dict)

	def __post_init__(self) -> None:
		p = self.path or os.environ.get("FG_TABLE_PATH")
		if not p:
			proj_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
			p = os.path.join(proj_root, "data", "fg_table.parquet")
		if not os.path.exists(p):
			raise RuntimeError(f"FG parquet not found at {p}; run scripts/export_precomputed.py")
		df = pd.read_parquet(p)
		for _, row in df.iterrows():
			self._fg[int(row["kick_dist"])] = float(row["p"]) 

	def make_probability(self, yards: int, is_home: bool, state: LiveState) -> float:
		k = int(max(18, min(80, yards)))
		return float(self._fg.get(k, 0.5))


@dataclass
class PrecomputedPatDecisionModel:
	path: Optional[str] = None
	_index: Dict[Tuple[int, int, int, int, int], float] = field(default_factory=dict)

	def __post_init__(self) -> None:
		p = self.path or os.environ.get("PAT_TABLE_PATH")
		if not p:
			proj_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
			p = os.path.join(proj_root, "data", "pat_decision_table.parquet")
		if not os.path.exists(p):
			raise RuntimeError(f"PAT decision parquet not found at {p}; run scripts/export_precomputed.py")
		df = pd.read_parquet(p)
		for _, row in df.iterrows():
			key = (int(row["qtr"]), int(row["sec_b_qtr"]), int(row["score_differential"]), int(row["to_off"]), int(row["to_def"]))
			self._index[key] = float(row["p_go"])

	def go_for_two_prob(self, state: LiveState, is_home_offense: bool) -> float:
		sec_b_q = _sec_bin_qtr(state.seconds_remaining)
		adj_diff = int(state.score_diff if is_home_offense else -state.score_diff)
		to_off = int(state.timeouts_home if is_home_offense else state.timeouts_away)
		to_def = int(state.timeouts_away if is_home_offense else state.timeouts_home)
		key = (int(state.quarter), int(sec_b_q), int(adj_diff), int(to_off), int(to_def))
		return float(self._index.get(key, 0.0))


@dataclass
class PrecomputedTwoPointSuccessModel:
	path: Optional[str] = None
	_index: Dict[Tuple[int, int], float] = field(default_factory=dict)

	def __post_init__(self) -> None:
		p = self.path or os.environ.get("TWO_PT_TABLE_PATH")
		if not p:
			proj_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
			p = os.path.join(proj_root, "data", "two_point_table.parquet")
		if not os.path.exists(p):
			raise RuntimeError(f"2PT parquet not found at {p}; run scripts/export_precomputed.py")
		df = pd.read_parquet(p)
		for _, row in df.iterrows():
			key = (int(row["qtr"]), int(row["sec_b_half"]))
			self._index[key] = float(row["p_success"]) 

	def success_prob(self, state: LiveState, is_home_offense: bool) -> float:
		hsec = _half_seconds_remaining(state.quarter, state.seconds_remaining)
		key = (int(state.quarter), int(_sec_bin_half(hsec)))
		return float(self._index.get(key, 0.5))
