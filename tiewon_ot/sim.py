from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, List, Tuple, Dict, Any

import os
import json
import sys
import time
import numpy as np

from .state import LiveState, Possession
from .submodels import (
	ClockModel,
	DriveModel,
	FieldGoalModel,
	FourthDownPolicy,
	EPDrivenDriveModel,
	EmpiricalClockModel,
	DriveOutcome,
)
from .adapters.r_fastr import RFastRFieldGoalModel, RFastREPProvider, RFastRPatDecisionModel, RFastRTwoPointSuccessModel
from .adapters.precomputed import PrecomputedTwoPointSuccessModel
from .adapters.r_nfl4th import RFastRFourthDownPolicy


class RuleEra(str, Enum):
	PRE_2012 = "pre_2012"
	ERA_2012_2021 = "2012_2021"
	ERA_2022_2024 = "2022_2024"
	ERA_2025_PLUS = "2025_plus"


def _require_condition(cond: bool, msg: str) -> None:
	if not cond:
		raise RuntimeError(msg)


def _default_clock() -> ClockModel:
	override = os.environ.get("CLOCK_TABLE_PATH")
	if override and os.path.exists(override):
		return EmpiricalClockModel.from_json(override)
	proj_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
	cand_top = os.path.join(proj_root, "data", "clock_table.json")
	cand_pkg = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "clock_table.json"))
	for path in (cand_top, cand_pkg):
		if os.path.exists(path):
			return EmpiricalClockModel.from_json(path)
	raise RuntimeError("Empirical clock table not found; set CLOCK_TABLE_PATH or build data/clock_table.json with scripts/build_clock_table.py")


def _default_drive() -> DriveModel:
	return EPDrivenDriveModel(ep_provider=RFastREPProvider())


def _default_fg() -> FieldGoalModel:
	return RFastRFieldGoalModel()


def _default_fourth() -> FourthDownPolicy:
	return RFastRFourthDownPolicy()


@dataclass
class SimulatorConfig:
	clock: ClockModel = field(default_factory=_default_clock)
	drive: DriveModel = field(default_factory=_default_drive)
	fg: FieldGoalModel = field(default_factory=_default_fg)
	fourth: FourthDownPolicy = field(default_factory=_default_fourth)
	max_plays: int = 400
	prune_no_time: bool = True
	rule_era: RuleEra = RuleEra.ERA_2025_PLUS
	use_spread_prior: bool = False
	parallel_workers: int = 0
	log_snapshots: bool = False
	snapshots: List[dict] = field(default_factory=list)
	pat_decider: Optional[RFastRPatDecisionModel] = None
	two_pt_model: Optional[RFastRTwoPointSuccessModel] = None

	def to_kwargs(self) -> Dict[str, Any]:
		return {
			"max_plays": self.max_plays,
			"prune_no_time": self.prune_no_time,
			"rule_era": self.rule_era,
			"use_spread_prior": self.use_spread_prior,
			"log_snapshots": False,
		}


def _apply_two_minute_boundary(state: LiveState, advance: int) -> int:
	if state.quarter in (2, 4):
		if state.seconds_remaining > 120 and state.seconds_remaining - advance < 120:
			return state.seconds_remaining - 120
	return advance


# Instrumentation for late-game (final 2:00) behavior
@dataclass
class LateGameMetrics:
	"""Aggregated metrics for the final two minutes of regulation (Q4).

	Counts drive segments that occur within the final 120 seconds (including a
	segment that started before 2:00 but continues into it), scoring attempts,
	field goal makes, and time spent per segment.
	"""
	num_drives: int = 0
	fg_attempts: int = 0
	fg_makes: int = 0
	scoring_attempts: int = 0  # FG_ATT + TD
	drive_time_accum: float = 0.0
	kick_dist_sum: float = 0.0

	def add_drive(self) -> None:
		self.num_drives += 1

	def add_time(self, sec: int) -> None:
		self.drive_time_accum += float(sec)
def _heuristic_pat_go_prob(state: LiveState, is_home_offense: bool) -> float:
	"""Simple, interpretable PAT decision heuristic.

	Uses pre-TD score differential from the offense perspective, quarter, and time remaining.
	"""
	adj_diff = int(state.score_diff if is_home_offense else -state.score_diff)
	# Discrete, football-logic heuristic keyed on pre-TD diff
	late = state.quarter == 4
	# Early and late probabilities (early_p, late_p)
	if adj_diff == -8:
		pe, pl = 0.80, 0.95
	elif adj_diff == -7:
		pe, pl = 0.00, 0.20
	elif adj_diff == -6:
		pe, pl = 0.00, 0.05
	elif adj_diff == -5:
		pe, pl = 0.60, 0.85
	elif adj_diff == -4:
		pe, pl = 0.15, 0.25
	elif adj_diff == -3:
		pe, pl = 0.25, 0.40
	elif adj_diff == -2:
		pe, pl = 0.00, 0.15
	elif adj_diff == -1:
		pe, pl = 0.50, 0.85
	elif adj_diff == 0:
		pe, pl = 0.20, 0.30
	elif adj_diff == 1:
		pe, pl = 0.05, 0.15
	elif adj_diff == 2:
		pe, pl = 0.05, 0.10
	elif adj_diff == 9:
		pe, pl = 0.02, 0.15
	else:
		# Default for larger leads: almost never
		pe, pl = 0.02, 0.05
	p = pl if late else pe
	return float(np.clip(p, 0.05, 0.95))



def simulate_once(initial: LiveState, rng: np.random.Generator, cfg: SimulatorConfig, late_metrics: Optional[LateGameMetrics] = None) -> int:
	state = initial.model_copy(deep=True)
	plays = 0
	# Remove upfront PAT adapter init; instantiate only when needed
	in_final_two = False
	current_possession_in_window = False
	while True:
		if state.quarter > 4:
			break
		if state.quarter == 4 and state.seconds_remaining == 0:
			break
		if plays >= cfg.max_plays:
			break

		event, payload = cfg.drive.next_event(state, rng)
		if state.yardline_own >= 99 and event == DriveOutcome.FIRST_DOWN:
			event = DriveOutcome.TD

		advance = min(cfg.clock.advance_seconds(state, rng), state.seconds_remaining)
		advance = _apply_two_minute_boundary(state, advance)
		state.seconds_remaining -= advance
		# Late-game window entry and time accumulation
		if state.quarter == 4 and state.seconds_remaining <= 120:
			if not in_final_two:
				in_final_two = True
				current_possession_in_window = True
				if late_metrics is not None:
					late_metrics.add_drive()
			if late_metrics is not None:
				late_metrics.add_time(advance)
		if event == DriveOutcome.END_HALF:
			if state.quarter < 4:
				state.quarter += 1
				state.seconds_remaining = 15 * 60
				plays += 1
				continue
			else:
				break
		if state.seconds_remaining == 120 and state.quarter in (2, 4):
			pass
		elif state.seconds_remaining == 0:
			if state.quarter < 4:
				state.quarter += 1
				state.seconds_remaining = 15 * 60
			else:
				pass

		if event == DriveOutcome.TD:
			is_home_off = state.possession == Possession.HOME
			pre_diff = state.score_diff
			# Add 6 for TD first
			state.score_diff = state.score_diff + 6 if is_home_off else state.score_diff - 6
			if in_final_two and late_metrics is not None:
				late_metrics.scoring_attempts += 1
			# Mark PAT pending
			from .state import PatPending
			# Decide PAT using pre-TD snapshot
			st_for_pat = state.model_copy(deep=True)
			st_for_pat.score_diff = pre_diff
			# Use inline heuristic for PAT decision unless a custom decider is provided
			# Prefer precomputed/heuristic 2PT success model by default
			if cfg.two_pt_model is None:
				try:
					cfg.two_pt_model = PrecomputedTwoPointSuccessModel()
				except Exception:
					cfg.two_pt_model = RFastRTwoPointSuccessModel()
			if cfg.pat_decider is not None:
				p_go = cfg.pat_decider.go_for_two_prob(st_for_pat, is_home_off)
			else:
				p_go = _heuristic_pat_go_prob(st_for_pat, is_home_off)
			if rng.random() < p_go and ((is_home_off and state.home_two_pt_available) or ((not is_home_off) and state.away_two_pt_available)):
				state.pat_pending = PatPending.TWO
				p_make_2 = cfg.two_pt_model.success_prob(st_for_pat, is_home_off)
				# Assume PAT consumes a few seconds
				state.seconds_remaining = max(0, state.seconds_remaining - 5)
				if rng.random() < p_make_2:
					state.score_diff = state.score_diff + 2 if is_home_off else state.score_diff - 2
			else:
				state.pat_pending = PatPending.XP
				# XP kick from ~33 yards
				xp_dist = 33
				state.seconds_remaining = max(0, state.seconds_remaining - 5)
				if rng.random() < cfg.fg.make_probability(xp_dist, is_home_off, st_for_pat):
					state.score_diff = state.score_diff + 1 if is_home_off else state.score_diff - 1
			# Clear PAT pending and kickoff
			state.pat_pending = PatPending.NONE
			state.possession = Possession.AWAY if state.possession == Possession.HOME else Possession.HOME
			state.down = 1
			state.distance = 10
			state.yardline_own = 25
		elif event == DriveOutcome.FIRST_DOWN:
			g = max(1, payload.get("yards", state.distance))
			state.down = 1
			state.distance = 10
			state.yardline_own = min(99, state.yardline_own + g)
		elif event in (DriveOutcome.PUNT, DriveOutcome.TURNOVER):
			net = int(rng.integers(35, 55))
			new_spot_old_perspective = max(1, min(99, state.yardline_own + net))
			state.possession = Possession.AWAY if state.possession == Possession.HOME else Possession.HOME
			state.down = 1
			state.distance = 10
			state.yardline_own = max(1, min(99, 100 - new_spot_old_perspective))
			# New drive within final two minutes
			if in_final_two and late_metrics is not None and not current_possession_in_window:
				late_metrics.add_drive()
				current_possession_in_window = True
		elif event == DriveOutcome.FG_ATT:
			# Late-game: sample kick distance realistically only if in range and EP is high
			if in_final_two and state.yardline_own >= 65:
				kick_dist = float(np.clip(rng.normal(40.0, 5.0), 25.0, 55.0))
			else:
				yards_to_goal = 100 - state.yardline_own
				kick_dist = float(yards_to_goal + 17)
			is_home = state.possession == Possession.HOME
			pre_yardline = state.yardline_own
			if in_final_two and late_metrics is not None:
				late_metrics.fg_attempts += 1
				late_metrics.scoring_attempts += 1
				late_metrics.kick_dist_sum += float(kick_dist)
			make_prob = cfg.fg.make_probability(kick_dist, is_home, state)
			# Mild late-game protection only in final 2:00; avoid global clamp
			if in_final_two:
				if kick_dist <= 40:
					make_prob = max(0.85, float(make_prob))
				elif kick_dist <= 45:
					make_prob = max(0.80, float(make_prob))
			if rng.random() < make_prob:
				state.score_diff = state.score_diff + 3 if is_home else state.score_diff - 3
				if in_final_two and late_metrics is not None:
					late_metrics.fg_makes += 1
				state.possession = Possession.AWAY if is_home else Possession.HOME
				state.down = 1
				state.distance = 10
				state.yardline_own = 25
			else:
				state.possession = Possession.AWAY if is_home else Possession.HOME
				state.down = 1
				state.distance = 10
				spot_of_kick_old = max(1, pre_yardline - 7)
				state.yardline_own = max(1, min(99, 100 - spot_of_kick_old))
			# New drive in window after FG sequence
			if in_final_two and late_metrics is not None:
				late_metrics.add_drive()
				current_possession_in_window = True

		plays += 1

		if cfg.prune_no_time and state.quarter == 4 and state.seconds_remaining <= 5 and state.score_diff != 0:
			break

	if cfg.log_snapshots:
		cfg.snapshots.append({
			"final_score_diff": state.score_diff,
			"quarter": state.quarter,
			"seconds_remaining": state.seconds_remaining,
		})
	return 1 if state.score_diff == 0 else 0


def simulate_overtime_prob(
	state: LiveState,
	num_simulations: int = 50000,
	random_seed: Optional[int] = None,
	config: Optional[SimulatorConfig] = None,
	progress: bool = False,
) -> float:
	rng = np.random.default_rng(random_seed)
	cfg = config or SimulatorConfig()
	results = np.zeros(num_simulations, dtype=np.int8)
	late_agg = LateGameMetrics()
	# Classify common late-game debug scenarios
	scenario_label = None
	if state.quarter == 4 and state.seconds_remaining <= 120 and state.score_diff == 0:
		scenario_label = "Q4_tie"
	elif state.quarter == 4 and state.seconds_remaining <= 120 and state.score_diff == -3:
		scenario_label = "Q4_down3"
	elif state.quarter == 4 and state.seconds_remaining <= 120 and state.score_diff == 1 and state.possession == Possession.AWAY:
		scenario_label = "Q4_up1_opp_ball"
	start_time = time.perf_counter()
	update_every = max(1, num_simulations // 100)
	for i in range(num_simulations):
		results[i] = simulate_once(state, rng, cfg, late_metrics=late_agg)
		if progress and ((i + 1) % update_every == 0 or (i + 1) == num_simulations):
			elapsed = time.perf_counter() - start_time
			pct = float(i + 1) / float(num_simulations)
			remaining = (elapsed / max(pct, 1e-9)) * (1.0 - pct)
			line = f"[{int(pct*100):3d}%] {i+1}/{num_simulations} sims | elapsed {elapsed:.1f}s | remaining {remaining:.1f}s"
			# Always update in-place; every 100 sims also emit a newline to force display
			print(line, file=sys.stdout, end="\r", flush=True)
			if ((i + 1) % 100) == 0 or (i + 1) == num_simulations:
				print(line, file=sys.stdout, flush=True)
	if progress:
		elapsed = time.perf_counter() - start_time
		print("", file=sys.stdout)
		print(f"Completed {num_simulations} sims in {elapsed:.2f}s", file=sys.stdout)
		# Late game metrics summary
		avg_drive_time = (late_agg.drive_time_accum / max(1, late_agg.num_drives)) if late_agg.num_drives > 0 else 0.0
		avg_kick_dist = (late_agg.kick_dist_sum / max(1, late_agg.fg_attempts)) if late_agg.fg_attempts > 0 else 0.0
		print(f"Late-game (Q4<=2:00): drives={late_agg.num_drives} attempts={late_agg.scoring_attempts} FG={late_agg.fg_makes}/{late_agg.fg_attempts} avg_drive_time={avg_drive_time:.1f}s avg_kick_dist={avg_kick_dist:.1f}yd", file=sys.stdout)
		if scenario_label is not None:
			per_sim_drives = late_agg.num_drives / float(num_simulations)
			per_sim_attempts = late_agg.scoring_attempts / float(num_simulations)
			per_sim_fg_att = late_agg.fg_attempts / float(num_simulations)
			per_sim_fg_mk = late_agg.fg_makes / float(num_simulations)
			print(f"Scenario={scenario_label} per-sim: drives={per_sim_drives:.2f} attempts={per_sim_attempts:.2f} FG_att={per_sim_fg_att:.2f} FG_mk={per_sim_fg_mk:.2f}", file=sys.stdout)
		# Write CSV row for diagnostics
		try:
			outdir = os.path.join(os.getcwd(), "diagnostics_out")
			os.makedirs(outdir, exist_ok=True)
			csv_path = os.path.join(outdir, "late_game_metrics.csv")
			write_header = not os.path.exists(csv_path)
			with open(csv_path, "a") as f:
				if write_header:
					f.write("scenario,num_drives,scoring_attempts,fg_attempts,fg_makes,avg_drive_time,avg_kick_dist,per_sim_drives,per_sim_attempts,per_sim_fg_att,per_sim_fg_mk\n")
				f.write(
					f"{scenario_label or ''},{late_agg.num_drives},{late_agg.scoring_attempts},{late_agg.fg_attempts},{late_agg.fg_makes},{avg_drive_time:.2f},{avg_kick_dist:.2f},{late_agg.num_drives/float(num_simulations):.3f},{late_agg.scoring_attempts/float(num_simulations):.3f},{late_agg.fg_attempts/float(num_simulations):.3f},{late_agg.fg_makes/float(num_simulations):.3f}\n"
				)
		except Exception:
			pass
	return float(results.mean())


def _warmup_r_dependencies(state: LiveState) -> None:
	"""Eagerly load R-backed data/models once in the parent process to prime caches.
	This avoids concurrent first-time reads (e.g., nfl4th/nflreadr caches) across workers.
	"""
	try:
		pat = RFastRPatDecisionModel()
		two = RFastRTwoPointSuccessModel()
		# Use a minimal, safe state snapshot resembling a post-TD decision context
		stub = state.model_copy(deep=True)
		# Ensure fields are sane for PAT decision
		stub.seconds_remaining = max(0, int(stub.seconds_remaining))
		stub.quarter = max(1, int(stub.quarter))
		# Trigger one call each to force R packages to load data and set up caches
		_ = pat.go_for_two_prob(stub, True)
		_ = two.success_prob(stub, True)
	except Exception:
		# Warmup is best-effort; failures will surface in worker processes if persistent
		pass

def _worker_sim_chunk(args: Tuple[dict, int, int, Dict[str, Any]]) -> dict:
	state_dict, seed_int, num_iters, cfg_kwargs = args
	cfg = SimulatorConfig(**cfg_kwargs)
	rng = np.random.default_rng(seed_int)
	count = 0
	lg = LateGameMetrics()
	state = LiveState(**state_dict)
	for _ in range(num_iters):
		count += simulate_once(state, rng, cfg, late_metrics=lg)
	return {
		"count": count,
		"lg": {
			"num_drives": lg.num_drives,
			"fg_attempts": lg.fg_attempts,
			"fg_makes": lg.fg_makes,
			"scoring_attempts": lg.scoring_attempts,
			"drive_time_accum": lg.drive_time_accum,
		},
	}


def simulate_overtime_prob_parallel(
	state: LiveState,
	num_simulations: int,
	workers: int = 4,
	random_seed: Optional[int] = None,
	config: Optional[SimulatorConfig] = None,
	progress: bool = False,
) -> float:
	import multiprocessing as mp
	cfg = config or SimulatorConfig()
	# Prime R-dependent caches before forking/spawning worker processes to avoid race conditions
	try:
		_warmup_r_dependencies(state)
	except Exception:
		pass
	workers = max(1, int(workers))
	# Create more granular tasks to enable progress updates
	target_tasks = max(workers * 32, 32)
	target_tasks = min(target_tasks, num_simulations)
	base = num_simulations // max(1, target_tasks)
	rem = num_simulations % max(1, target_tasks)
	chunk_sizes: List[int] = [base + (1 if i < rem else 0) for i in range(target_tasks)]
	chunk_sizes = [n for n in chunk_sizes if n > 0]
	seed_seq = np.random.SeedSequence(random_seed)
	child_seeds = seed_seq.spawn(len(chunk_sizes))
	state_dict = state.model_dump()
	cfg_kwargs = cfg.to_kwargs()
	args = [(state_dict, int(cs.generate_state(1, dtype=np.uint64)[0] & 0xFFFFFFFF), n, cfg_kwargs) for cs, n in zip(child_seeds, chunk_sizes)]
	start_time = time.perf_counter()
	completed_sims = 0
	completed_counts = 0
	late_agg = LateGameMetrics()
	with mp.Pool(processes=workers) as pool:
		# Print an initial progress line
		if progress:
			print(f"[  0%] 0/{num_simulations} sims | elapsed 0.0s | remaining --.-s", file=sys.stdout, end="\r", flush=True)
		for idx, result in enumerate(pool.imap_unordered(_worker_sim_chunk, args), 1):
			completed_counts += int(result.get("count", 0))
			lg = result.get("lg", {})
			late_agg.num_drives += int(lg.get("num_drives", 0))
			late_agg.fg_attempts += int(lg.get("fg_attempts", 0))
			late_agg.fg_makes += int(lg.get("fg_makes", 0))
			late_agg.scoring_attempts += int(lg.get("scoring_attempts", 0))
			late_agg.drive_time_accum += float(lg.get("drive_time_accum", 0.0))
			completed_sims += int(chunk_sizes[idx - 1])
			if progress:
				elapsed = time.perf_counter() - start_time
				pct = float(completed_sims) / float(num_simulations)
				remaining = (elapsed / max(pct, 1e-9)) * (1.0 - pct)
				line = f"[{int(pct*100):3d}%] {completed_sims}/{num_simulations} sims | elapsed {elapsed:.1f}s | remaining {remaining:.1f}s"
				print(line, file=sys.stdout, end="\r", flush=True)
				if (completed_sims % 100) == 0 or completed_sims == num_simulations:
					print(line, file=sys.stdout, flush=True)
	if progress:
		elapsed = time.perf_counter() - start_time
		print("", file=sys.stdout)
		print(f"Completed {num_simulations} sims in {elapsed:.2f}s", file=sys.stdout)
		# Late game metrics summary
		avg_drive_time = (late_agg.drive_time_accum / max(1, late_agg.num_drives)) if late_agg.num_drives > 0 else 0.0
		print(f"Late-game (Q4<=2:00): drives={late_agg.num_drives} attempts={late_agg.scoring_attempts} FG={late_agg.fg_makes}/{late_agg.fg_attempts} avg_drive_time={avg_drive_time:.1f}s", file=sys.stdout)
		# Write CSV row for diagnostics
		try:
			outdir = os.path.join(os.getcwd(), "diagnostics_out")
			os.makedirs(outdir, exist_ok=True)
			csv_path = os.path.join(outdir, "late_game_metrics.csv")
			write_header = not os.path.exists(csv_path)
			with open(csv_path, "a") as f:
				if write_header:
					f.write("scenario,num_drives,scoring_attempts,fg_attempts,fg_makes,avg_drive_time,per_sim_drives,per_sim_attempts,per_sim_fg_att,per_sim_fg_mk\n")
				scenario_label = ""
				per_sim_drives = late_agg.num_drives / float(max(1, num_simulations))
				per_sim_attempts = late_agg.scoring_attempts / float(max(1, num_simulations))
				per_sim_fg_att = late_agg.fg_attempts / float(max(1, num_simulations))
				per_sim_fg_mk = late_agg.fg_makes / float(max(1, num_simulations))
				f.write(f"{scenario_label},{late_agg.num_drives},{late_agg.scoring_attempts},{late_agg.fg_attempts},{late_agg.fg_makes},{avg_drive_time:.2f},{per_sim_drives:.3f},{per_sim_attempts:.3f},{per_sim_fg_att:.3f},{per_sim_fg_mk:.3f}\n")
		except Exception:
			pass
	return float(completed_counts / num_simulations)
