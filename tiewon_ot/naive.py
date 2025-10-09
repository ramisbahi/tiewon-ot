from __future__ import annotations

import numpy as np

from .state import LiveState


def prob_tie_if_tied_and_no_scoring(state: LiveState) -> float:
	# If already tied now, and no further scoring occurs, game goes to OT
	return 1.0 if state.score_diff == 0 else 0.0


def naive_no_score_pot(state: LiveState, p_no_more_scoring: float) -> float:
	# Naive baseline: tie only if currently tied and no one scores
	return float(p_no_more_scoring * (1.0 if state.score_diff == 0 else 0.0))
