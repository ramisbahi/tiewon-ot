from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Tuple, Dict, Any, Optional

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression


@dataclass
class BaselineSnapshotModel:
	feature_order: list[str]
	tree_params: Dict[str, Any] | None = None
	gbm: GradientBoostingClassifier | None = None
	iso: IsotonicRegression | None = None

	def fit(self, X: np.ndarray, y: np.ndarray) -> None:
		params = {
			"n_estimators": 400,
			"learning_rate": 0.03,
			"max_depth": 3,
			"subsample": 0.9,
			"random_state": 1,
		}
		if self.tree_params:
			params.update(self.tree_params)
		self.gbm = GradientBoostingClassifier(**params)
		self.gbm.fit(X, y)
		probs = self.gbm.predict_proba(X)[:, 1]
		self.iso = IsotonicRegression(out_of_bounds="clip")
		self.iso.fit(probs, y)

	def predict_proba(self, X: np.ndarray) -> np.ndarray:
		assert self.gbm is not None and self.iso is not None
		raw = self.gbm.predict_proba(X)[:, 1]
		cal = self.iso.transform(raw)
		return cal
