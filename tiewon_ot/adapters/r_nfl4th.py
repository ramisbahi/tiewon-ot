from __future__ import annotations

from dataclasses import dataclass

try:
	from rpy2 import robjects as ro
	from rpy2.robjects.packages import importr
	has_r = True
except Exception:  # pragma: no cover
	has_r = False

from ..state import LiveState, Possession
from ..submodels import FourthDownPolicy


def half_seconds_remaining(qtr: int, qtr_seconds: int) -> int:
	"""Return seconds remaining in the current half (Q1/Q2 or Q3/Q4)."""
	return int(qtr_seconds + (900 if qtr in (1, 3) else 0))


@dataclass
class RFastRFourthDownPolicy(FourthDownPolicy):
	"""Fourth-down decision adapter using nfl4th via rpy2.

	Returns one of 'go', 'fg', 'punt' based on probabilities from nfl4th.
	"""
	def __post_init__(self) -> None:
		if not has_r:
			raise RuntimeError("rpy2 not available; install to use R nfl4th adapter")
		self._nfl4th = importr("nfl4th")
		# Predefine an R helper to add 4th probs on a tiny data.frame
		self._pred_fun = ro.r(
			"function(df) { nfl4th::add_4th_probs(df) }"
		)

	def choose(self, state: LiveState) -> str:
		# Build minimal R dataframe; nfl4th expects nflfastR-like fields
		yardline_100 = 100 - state.yardline_own
		posteam_timeouts = state.timeouts_home if state.possession == Possession.HOME else state.timeouts_away
		defteam_timeouts = state.timeouts_away if state.possession == Possession.HOME else state.timeouts_home
		hsec = half_seconds_remaining(state.quarter, state.seconds_remaining)
		r_df = ro.DataFrame({
			"yardline_100": ro.IntVector([yardline_100]),
			"ydstogo": ro.IntVector([state.distance]),
			"down": ro.IntVector([state.down]),
			"qtr": ro.IntVector([state.quarter]),
			"half_seconds_remaining": ro.IntVector([hsec]),
			"posteam_timeouts": ro.IntVector([posteam_timeouts]),
			"defteam_timeouts": ro.IntVector([defteam_timeouts]),
		})
		res = self._pred_fun(r_df)
		# nfl4th typically adds columns like: go_boost, go_wp, fg_wp, punt_wp, go, fg, punt probabilities
		# We’ll look for columns named 'go', 'fg', 'punt' or infer from *_wp
		colnames = list(res.names)
		p_go = float(res.rx2("go")[0]) if "go" in colnames else 0.0
		p_fg = float(res.rx2("fg")[0]) if "fg" in colnames else 0.0
		p_punt = float(res.rx2("punt")[0]) if "punt" in colnames else 0.0
		if p_go == p_fg == p_punt == 0.0:
			# Fallback heuristic: choose by maximizing win prob columns if present
			try:
				go_wp = float(res.rx2("go_wp")[0])
				fg_wp = float(res.rx2("fg_wp")[0])
				punt_wp = float(res.rx2("punt_wp")[0])
				action = max(("go", go_wp), ("fg", fg_wp), ("punt", punt_wp), key=lambda x: x[1])[0]
				return action
			except Exception:
				pass
		# Choose max probability
		action = max(("go", p_go), ("fg", p_fg), ("punt", p_punt), key=lambda x: x[1])[0]
		return action
