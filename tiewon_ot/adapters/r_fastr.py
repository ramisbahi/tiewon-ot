from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Tuple, Dict

import numpy as np
import os
try:
	import fcntl  # type: ignore
except Exception:  # pragma: no cover
	fcntl = None  # type: ignore

from ..state import LiveState
from ..submodels import FieldGoalModel


def half_seconds_remaining(qtr: int, qtr_seconds: int) -> int:
	"""Return seconds remaining in the current half (Q1/Q2 or Q3/Q4)."""
	return int(qtr_seconds + (900 if qtr in (1, 3) else 0))


def _silence_r_console() -> None:
	"""Silence R console prints (but not errors) via rpy2 callbacks."""
	try:
		from rpy2.rinterface_lib import callbacks as _rpy2_callbacks  # type: ignore
		_rpy2_callbacks.consolewrite_print = lambda x: None  # type: ignore
		_rpy2_callbacks.consolewrite_warnerror = lambda x: None  # type: ignore
	except Exception:
		# Best-effort; if unavailable, skip silently
		pass


@dataclass
class RFastRFieldGoalModel(FieldGoalModel):
	default_roof: str = "outdoors"
	default_surface: str = "grass"
	default_temp_f: float = 70.0
	default_wind_mph: float = 5.0
	_fg_cache: Dict[Tuple[int, bool, str, str, int, int], float] = field(default_factory=dict)
	_ro = None
	_importr = None
	_pred_fun = None

	def __post_init__(self) -> None:
		try:
			from rpy2 import robjects as ro  # type: ignore
			from rpy2.robjects.packages import importr  # type: ignore
			self._ro = ro
			self._importr = importr
			_silence_r_console()
			self._importr("fastrmodels")
			self._importr("mgcv")
			self._pred_fun = ro.r(
				"function(df) { m <- fastrmodels::fg_model; df$model_roof <- factor(df$model_roof, levels=m$xlevels$model_roof); df$era <- factor(df$era, levels=m$xlevels$era); mgcv::predict.gam(m, newdata=df, type='response') }"
			)
		except Exception as e:  # pragma: no cover
			raise RuntimeError(f"rpy2/R setup failed for FG adapter: {e}")

	def make_probability(self, yards: int, is_home: bool, state: LiveState) -> float:
		# Convert kick distance back to yardline_100 approximation: kick_dist ≈ yardline_100 + 17
		yardline_100 = max(1, min(99, yards - 17))
		roof = self.default_roof
		model_roof = roof
		# era factor: use current era level '3'
		era = "3"
		key = (int(yards), bool(is_home), roof, era)
		if key in self._fg_cache:
			return self._fg_cache[key]
		r_df = self._ro.DataFrame({
			"model_roof": self._ro.FactorVector(self._ro.StrVector([model_roof])),
			"era": self._ro.FactorVector(self._ro.StrVector([era])),
			"yardline_100": self._ro.FloatVector([float(yardline_100)]),
		})
		p = float(self._pred_fun(r_df)[0])
		p = float(np.clip(p, 0.01, 0.999))
		self._fg_cache[key] = p
		return p


@dataclass
class RFastREPProvider:
	"""Provides Expected Points for a given state using nflfastR calculate_expected_points (avoids raw model)."""
	_ep_cache: Dict[Tuple[int, int, int, int, int], float] = field(default_factory=dict)
	_ro = None
	_importr = None
	_pred_fun = None

	def __post_init__(self) -> None:
		try:
			from rpy2 import robjects as ro  # type: ignore
			from rpy2.robjects.packages import importr  # type: ignore
			self._ro = ro
			self._importr = importr
			_silence_r_console()
			self._importr("nflfastR")
			self._importr("dplyr")
			self._pred_fun = ro.r(
				"function(df) { options(nflreadr.verbose = FALSE); "
				"suppressMessages(suppressWarnings(library(dplyr))); "
				"suppressMessages(suppressWarnings(library(nflfastR))); "
				"pbp <- df %>% mutate(\n"
					"season = ifelse(is.na(season), 2025L, as.integer(season)),\n"
					"home_team = ifelse(is.na(home_team), 'HOME', home_team),\n"
					"posteam_timeouts_remaining = ifelse(is.na(posteam_timeouts_remaining), 0L, as.integer(posteam_timeouts_remaining)),\n"
					"defteam_timeouts_remaining = ifelse(is.na(defteam_timeouts_remaining), 0L, as.integer(defteam_timeouts_remaining)),\n"
					"roof = ifelse(is.na(roof), 'outdoors', roof),\n"
					"surface = ifelse(is.na(surface), 'grass', surface)\n"
					"); "
				"suppressMessages(suppressWarnings(nflfastR::calculate_expected_points(pbp)$ep)) }"
			)
		except Exception as e:  # pragma: no cover
			raise RuntimeError(f"rpy2/R setup failed for EP adapter: {e}")

	def expected_points(self, state: LiveState) -> float:
		hsec = half_seconds_remaining(state.quarter, state.seconds_remaining)
		sec_bin = int((hsec // 5) * 5)
		key = (state.down, state.distance, 100 - state.yardline_own, state.quarter, sec_bin)
		if key in self._ep_cache:
			return self._ep_cache[key]
		# Minimal pbp-like row
		is_home_off = state.possession.value == 'home'
		posteam = "HOME" if is_home_off else "AWAY"
		defteam = "AWAY" if is_home_off else "HOME"
		home_team = "HOME"
		roof = "outdoors"
		surface = "grass"
		r_df = self._ro.DataFrame({
			"season": self._ro.IntVector([2025]),
			"down": self._ro.IntVector([state.down]),
			"ydstogo": self._ro.IntVector([state.distance]),
			"yardline_100": self._ro.IntVector([100 - state.yardline_own]),
			"qtr": self._ro.IntVector([state.quarter]),
			"half_seconds_remaining": self._ro.IntVector([hsec]),
			"posteam": self._ro.StrVector([posteam]),
			"defteam": self._ro.StrVector([defteam]),
			"home_team": self._ro.StrVector([home_team]),
			"posteam_timeouts_remaining": self._ro.IntVector([int(state.timeouts_home if is_home_off else state.timeouts_away)]),
			"defteam_timeouts_remaining": self._ro.IntVector([int(state.timeouts_away if is_home_off else state.timeouts_home)]),
			"roof": self._ro.StrVector([roof]),
			"surface": self._ro.StrVector([surface]),
		})
		ep = float(self._pred_fun(r_df)[0])
		self._ep_cache[key] = ep
		return ep


# PAT decision and 2-point success adapters
@dataclass
class RFastRPatDecisionModel:
	_ro = None
	_importr = None
	_predict = None
	_cache: Dict[Tuple[int, int, int], float] = field(default_factory=dict)

	def __post_init__(self) -> None:
		try:
			from rpy2 import robjects as ro  # type: ignore
			from rpy2.robjects.packages import importr  # type: ignore
			self._ro = ro
			self._importr = importr
			_silence_r_console()
			self._importr("nfl4th")
			# Wrapper: compute 2-pt vs XP WPs via add_2pt_probs and return both
			self._predict = ro.r(
				"function(df) {\n"
				"  options(nflreadr.verbose = FALSE)\n"
				"  if (requireNamespace('xgboost', quietly = TRUE)) { try(xgboost::xgb.set.config(verbosity = 0), silent = TRUE) }\n"
				"  pbp <- suppressMessages(suppressWarnings(nfl4th::add_2pt_probs(df)))\n"
				"  if (!all(c('wp_go2','wp_go1') %in% names(pbp))) stop('add_2pt_probs missing expected WP columns')\n"
				"  c(go=as.numeric(pbp$wp_go2[1]), xp=as.numeric(pbp$wp_go1[1]))\n"
				"}"
			)
		except Exception as e:
			raise RuntimeError(f"rpy2/R setup failed for PAT decision adapter: {e}")

	def go_for_two_prob(self, state: LiveState, is_home_offense: bool) -> float:
		hsec = half_seconds_remaining(state.quarter, state.seconds_remaining)
		adj_diff = int(state.score_diff if is_home_offense else -state.score_diff)
		key = (int(state.quarter), int(hsec // 5), adj_diff)
		if key in self._cache:
			return self._cache[key]
		# Build the minimal 2-pt decision row (post-TD situation)
		is_home = bool(is_home_offense)
		posteam = "HOME" if is_home else "AWAY"
		defteam = "AWAY" if is_home else "HOME"
		r_df = self._ro.DataFrame({
			"home_team": self._ro.StrVector(["HOME"]),
			"away_team": self._ro.StrVector(["AWAY"]),
			"posteam": self._ro.StrVector([posteam]),
			"defteam": self._ro.StrVector([defteam]),
			"type": self._ro.StrVector(["reg"]),
			"season": self._ro.IntVector([2025]),
			"qtr": self._ro.IntVector([state.quarter]),
			"quarter_seconds_remaining": self._ro.IntVector([state.seconds_remaining]),
			"score_differential": self._ro.IntVector([adj_diff]),
			"home_opening_kickoff": self._ro.IntVector([0]),
			"posteam_timeouts_remaining": self._ro.IntVector([int(state.timeouts_home if is_home else state.timeouts_away)]),
			"defteam_timeouts_remaining": self._ro.IntVector([int(state.timeouts_away if is_home else state.timeouts_home)]),
		})
		# Serialize nfl4th data access across processes to avoid readRDS cache races
		vals = None
		lock_path = "/tmp/tiewon-ot-nfl4th.lock"
		if fcntl is not None:
			os.makedirs(os.path.dirname(lock_path), exist_ok=True)
			with open(lock_path, "w") as lf:
				try:
					fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
					vals = self._predict(r_df)
				finally:
					try:
						fcntl.flock(lf.fileno(), fcntl.LOCK_UN)
					except Exception:
						pass
		else:
			vals = self._predict(r_df)
		p_go = float(vals.rx2(1)[0])
		p_xp = float(vals.rx2(2)[0])
		# Deterministic choice: probability 1 if go WP > XP WP, else 0
		p = 1.0 if p_go > p_xp else 0.0
		self._cache[key] = p
		return p


@dataclass
class RFastRTwoPointSuccessModel:
	_ro = None
	_importr = None
	_predict = None
	_cache: Dict[Tuple[int, int], float] = field(default_factory=dict)

	def __post_init__(self) -> None:
		try:
			from rpy2 import robjects as ro  # type: ignore
			from rpy2.robjects.packages import importr  # type: ignore
			self._ro = ro
			self._importr = importr
			_silence_r_console()
			self._importr("fastrmodels")
			self._predict = ro.r(
				'function(df) { '
				'  if (requireNamespace("xgboost", quietly = TRUE)) { try(xgboost::xgb.set.config(verbosity = 0), silent = TRUE) }; '
				'  m <- fastrmodels::cp_model; '
				'  if (inherits(m, "raw")) { '
				'    res <- NULL; '
				'    tryCatch({ '
				'      con <- base::gzcon(base::rawConnection(m)); '
				'      on.exit(try(close(con), silent=TRUE), add=TRUE); '
				'      res <- base::readRDS(con) '
				'    }, error = function(e) { '
				'      con2 <- base::rawConnection(m); '
				'      on.exit(try(close(con2), silent=TRUE), add=TRUE); '
				'      res <<- base::readRDS(con2) '
				'    }); '
				'    m <- res '
				'  }; '
				'  predict(m, newdata=df, type="response") '
				'}'
			)
		except Exception as e:  # pragma: no cover
			raise RuntimeError(f"rpy2/R setup failed for 2-point success adapter: {e}")

	def success_prob(self, state: LiveState, is_home_offense: bool) -> float:
		hsec = half_seconds_remaining(state.quarter, state.seconds_remaining)
		key = (int(state.quarter), int(hsec // 5))
		if key in self._cache:
			return self._cache[key]
		r_df = self._ro.DataFrame({
			"qtr": self._ro.IntVector([state.quarter]),
			"half_seconds_remaining": self._ro.IntVector([hsec]),
			"yardline_100": self._ro.IntVector([2]),
		})
		# Serialize fastrmodels cp_model access across processes
		lock_path = "/tmp/tiewon-ot-fastrmodels.lock"
		if fcntl is not None:
			os.makedirs(os.path.dirname(lock_path), exist_ok=True)
			with open(lock_path, "w") as lf:
				try:
					fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
					p = float(self._predict(r_df)[0])
				finally:
					try:
						fcntl.flock(lf.fileno(), fcntl.LOCK_UN)
					except Exception:
						pass
		else:
			p = float(self._predict(r_df)[0])
		p = float(np.clip(p, 0.0, 1.0))
		self._cache[key] = p
		return p
