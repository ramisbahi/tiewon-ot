from __future__ import annotations

from typing import Dict, Any

import numpy as np

from .state import LiveState, Possession


def livestate_to_features(state: LiveState) -> Dict[str, Any]:
	feat: Dict[str, Any] = {}
	feat["score_diff"] = state.score_diff
	feat["quarter"] = state.quarter
	feat["seconds_remaining_q"] = state.seconds_remaining
	feat["seconds_remaining_game"] = state.time_remaining_game
	feat["possession_home"] = 1 if state.possession == Possession.HOME else 0
	feat["down"] = state.down
	feat["distance"] = state.distance
	feat["yardline_own"] = state.yardline_own
	feat["timeouts_home"] = state.timeouts_home
	feat["timeouts_away"] = state.timeouts_away
	feat["home_two_pt_available"] = int(state.home_two_pt_available)
	feat["away_two_pt_available"] = int(state.away_two_pt_available)
	feat["closing_spread"] = state.closing_spread
	return feat


def features_to_array(features: Dict[str, Any], feature_order: list[str]) -> np.ndarray:
	return np.array([features.get(k, 0.0) for k in feature_order], dtype=float)
