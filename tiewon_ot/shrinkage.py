from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
from sklearn.isotonic import IsotonicRegression


@dataclass
class Calibrator:
	iso: Optional[IsotonicRegression] = None

	def fit(self, p_sim: np.ndarray, y_true: np.ndarray) -> None:
		self.iso = IsotonicRegression(out_of_bounds="clip")
		self.iso.fit(p_sim, y_true)

	def transform(self, p: np.ndarray) -> np.ndarray:
		if self.iso is None:
			return p
		return self.iso.transform(p)


def late_game_shrink(p_sim: float, p_naive: float, seconds_remaining: int, pivot: int = 120) -> float:
	# Linear blend toward naive near 0 seconds
	alpha = np.clip(seconds_remaining / max(1, pivot), 0.0, 1.0)
	# When time is low, alpha small => more weight on naive
	return float(alpha * p_sim + (1.0 - alpha) * p_naive)
