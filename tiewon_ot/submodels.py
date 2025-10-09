from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Tuple, Dict, Any, Optional

import json
import numpy as np
from enum import Enum

from .state import LiveState, Possession


class ClockModel(Protocol):
	"""Clock model interface.

	advance_seconds(state, rng, event) -> int: number of seconds to run off for the next play/event.
	Implementations may account for time, quarter, play type, and clock rules. Must return >= 1.
	"""
	def advance_seconds(self, state: LiveState, rng: np.random.Generator, event: Optional["DriveOutcome"] = None) -> int:
		...


class DriveOutcome(Enum):
	TD = "TD"
	FG_ATT = "FG_ATT"
	SAFETY = "SAFETY"
	PUNT = "PUNT"
	TURNOVER = "TURNOVER"
	FIRST_DOWN = "FIRST_DOWN"
	END_HALF = "END_HALF"


class DriveModel(Protocol):
	"""Drive/play transition model.

	next_event(state, rng) -> (event_type, payload)
	- event_type: one of DriveOutcome values
	- payload: optional dict with additional info (e.g., yards)
	"""
	def next_event(self, state: LiveState, rng: np.random.Generator) -> Tuple[DriveOutcome, dict]:
		...


class FieldGoalModel(Protocol):
	"""Field goal success probability provider.

	make_probability(yards, is_home, state) -> probability of make in [0,1].
	Implementations may use kicker/stadium/weather context.
	"""
	def make_probability(self, yards: int, is_home: bool, state: LiveState) -> float:
		...


class FourthDownPolicy(Protocol):
	def choose(self, state: LiveState) -> str:
		"""Return 'go', 'punt', or 'fg'"""
		...


class EPProvider(Protocol):
	"""Expected Points provider for current state."""
	def expected_points(self, state: LiveState) -> float:
		...


class PATDecisionModel(Protocol):
	"""Probability of attempting a 2-point conversion after a TD."""
	def go_for_two_prob(self, state: LiveState, is_home_offense: bool) -> float:
		...


class TwoPointSuccessModel(Protocol):
	"""Probability a 2-point conversion succeeds given state."""
	def success_prob(self, state: LiveState, is_home_offense: bool) -> float:
		...


@dataclass
class EmpiricalClockModel:
	"""Empirical clock using a JSON-derived table of mean/std seconds per play_type x time bin x timeout context."""
	table: Dict[str, Any]
	default_mean: float = 24.0
	default_std: float = 6.0
	min_seconds: int = 3
	max_seconds: int = 40
	_index: Dict[Tuple[str, int, int], Tuple[float, float]] | None = None

	@classmethod
	def from_json(cls, path: str) -> "EmpiricalClockModel":
		with open(path, "r") as f:
			obj = json.load(f)
		return cls(table=obj)

	def __post_init__(self) -> None:
		# Build index for O(1) lookup
		self._index = {}
		for row in self.table.get("stats", []):
			key = (row["play_type"], int(row["sec_bin"]), int(row["has_timeout"]))
			mu = float(row.get("mean", self.default_mean))
			sd = float(row.get("std", self.default_std))
			self._index[key] = (mu, sd)

	def _lookup(self, play_type: str, sec_bin: int, has_timeout: int) -> tuple[float, float]:
		if self._index is None:
			return self.default_mean, self.default_std
		return self._index.get((play_type, sec_bin, has_timeout), (self.default_mean, self.default_std))

	def _infer_play_type(self, state: LiveState, event: Optional[DriveOutcome]) -> str:
		# Map explicit outcomes first
		if event is not None:
			if event in (DriveOutcome.PUNT,):
				return "punt"
			if event in (DriveOutcome.FG_ATT,):
				return "field_goal"
			if event in (DriveOutcome.TURNOVER,):
				# Approximate as pass-like timing
				return "pass"
			if event in (DriveOutcome.TD,):
				# Treat as run/pass generic
				return "run"
		# Fallback: approximate from context
		if state.down == 4:
			kick_dist = (100 - state.yardline_own) + 17
			if kick_dist <= 60:
				return "field_goal"
			return "punt"
		return "run"

	def advance_seconds(self, state: LiveState, rng: np.random.Generator, event: Optional[DriveOutcome] = None) -> int:
		half_sec = state.seconds_remaining
		sec_bin_width = self.table.get("meta", {}).get("sec_bin_width", 5)
		sec_bin = int(half_sec // sec_bin_width)
		play_type = self._infer_play_type(state, event)
		has_timeout = 1 if (state.timeouts_home if state.possession == Possession.HOME else state.timeouts_away) > 0 else 0
		mu, sd = self._lookup(play_type, sec_bin, has_timeout)
		mu *= 1.05
		if state.quarter == 4 and state.seconds_remaining <= 120:
			mu *= 0.90
		base = np.clip(rng.normal(mu, sd), self.min_seconds, self.max_seconds)
		pace = max(0.5, rng.normal(1.0, 0.15))
		sec = int(np.clip(base * pace, self.min_seconds, self.max_seconds))
		return max(1, sec)


@dataclass
class EPDrivenDriveModel:
	"""Drive model using EP to stochastically choose outcomes.

	Empirical calibration assumptions:
	- ~10–12 drives per team per game
	- ~44 total points per game
	- OT rate ~5–6%

	Buckets EP into ranges and maps to drive-result probabilities.
	This version reduces scoring rates and adds small EP jitter to avoid over-determinism.
	"""
	ep_provider: EPProvider
	# Map: (low, high) -> {outcome: prob}
	bucket_map: Dict[Tuple[float, float], Dict[DriveOutcome, float]] | None = None
	end_half_threshold_sec: int = 1

	def __post_init__(self) -> None:
		if self.bucket_map is None:
			# Rebalanced probabilities: fewer TD/FG, more punts/turnovers, modest first-downs
			self.bucket_map = {
				(-10.0, -1.0): {DriveOutcome.PUNT: 0.708, DriveOutcome.TURNOVER: 0.122, DriveOutcome.FIRST_DOWN: 0.16, DriveOutcome.FG_ATT: 0.005, DriveOutcome.TD: 0.005},
				(-1.0, 0.5): {DriveOutcome.PUNT: 0.57, DriveOutcome.TURNOVER: 0.105, DriveOutcome.FIRST_DOWN: 0.30, DriveOutcome.FG_ATT: 0.015, DriveOutcome.TD: 0.01},
				(0.5, 2.0): {DriveOutcome.PUNT: 0.498, DriveOutcome.TURNOVER: 0.092, DriveOutcome.FIRST_DOWN: 0.35, DriveOutcome.FG_ATT: 0.035, DriveOutcome.TD: 0.025},
				(2.0, 4.0): {DriveOutcome.PUNT: 0.38, DriveOutcome.TURNOVER: 0.07, DriveOutcome.FIRST_DOWN: 0.45, DriveOutcome.FG_ATT: 0.06, DriveOutcome.TD: 0.04},
				(4.0, 10.0): {DriveOutcome.PUNT: 0.314, DriveOutcome.TURNOVER: 0.07, DriveOutcome.FIRST_DOWN: 0.461, DriveOutcome.FG_ATT: 0.09, DriveOutcome.TD: 0.065},
				(10.0, 99.0): {DriveOutcome.PUNT: 0.34, DriveOutcome.TURNOVER: 0.09, DriveOutcome.FIRST_DOWN: 0.37, DriveOutcome.FG_ATT: 0.10, DriveOutcome.TD: 0.10},
			}

	def _probs_for_ep(self, ep: float) -> Dict[DriveOutcome, float]:
		items = list(self.bucket_map.items())
		first_range, first_probs = items[0]
		last_range, last_probs = items[-1]
		if ep < first_range[0]:
			return first_probs
		if ep >= last_range[1]:
			return last_probs
		for (lo, hi), probs in items:
			if lo <= ep < hi:
				return probs
		return last_probs

	def next_event(self, state: LiveState, rng: np.random.Generator) -> Tuple[DriveOutcome, dict]:
		# Deterministic 4th-down shortcut: attempt FG if in reasonable range
		if state.down == 4:
			yards_to_goal = 100 - state.yardline_own
			kick_dist = yards_to_goal + 17
			if kick_dist <= 60:
				return (DriveOutcome.FG_ATT, {})
			# out of range: lean punt when deep
			if state.yardline_own < 60:
				return (DriveOutcome.PUNT, {})
			# otherwise fall through to EP-driven choice
		# EP jitter to reduce deterministic scoring bias
		ep = self.ep_provider.expected_points(state)
		ep = (ep + float(rng.normal(0.0, 0.6))) * 0.8
		probs = self._probs_for_ep(ep)
		# Late-game modest boost only when not tied and EP>2.0
		if state.quarter == 4 and state.seconds_remaining <= 120 and state.score_diff != 0 and ep > 2.0:
			p_punt = probs.get(DriveOutcome.PUNT, 0.0)
			p_to = probs.get(DriveOutcome.TURNOVER, 0.0)
			p_fd = probs.get(DriveOutcome.FIRST_DOWN, 0.0)
			p_fg = probs.get(DriveOutcome.FG_ATT, 0.0) * 1.2
			p_td = probs.get(DriveOutcome.TD, 0.0) * 1.2
			total = p_punt + p_to + p_fd + p_fg + p_td
			if total > 0:
				probs = {
					DriveOutcome.PUNT: p_punt / total,
					DriveOutcome.TURNOVER: p_to / total,
					DriveOutcome.FIRST_DOWN: p_fd / total,
					DriveOutcome.FG_ATT: p_fg / total,
					DriveOutcome.TD: p_td / total,
				}
		choices = list(probs.keys())
		pvals = np.array([probs[k] for k in choices], dtype=float)
		pvals = pvals / pvals.sum()
		idx = int(rng.choice(len(choices), p=pvals))
		choice = choices[idx]
		if choice == DriveOutcome.FIRST_DOWN:
			hi = max(state.distance, min(state.distance + 15, 30)) + 1
			gained = int(rng.integers(low=state.distance, high=hi))
			return (DriveOutcome.FIRST_DOWN, {"yards": gained})
		return (choice, {})
