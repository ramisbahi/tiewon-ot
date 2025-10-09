from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple

import numpy as np


def brier_score(y_true: np.ndarray, y_prob: np.ndarray) -> float:
	return float(np.mean((y_prob - y_true) ** 2))


@dataclass
class ReliabilityResult:
	bucket_edges: np.ndarray
	bucket_mean_pred: np.ndarray
	bucket_mean_true: np.ndarray
	bucket_counts: np.ndarray


def reliability_by_buckets(y_true: np.ndarray, y_prob: np.ndarray, num_buckets: int = 10) -> ReliabilityResult:
	edges = np.linspace(0.0, 1.0, num_buckets + 1)
	inds = np.digitize(y_prob, edges, right=True) - 1
	inds = np.clip(inds, 0, num_buckets - 1)
	pred_sum = np.zeros(num_buckets)
	true_sum = np.zeros(num_buckets)
	counts = np.zeros(num_buckets)
	for i in range(num_buckets):
		mask = inds == i
		if np.any(mask):
			pred_sum[i] = float(y_prob[mask].mean())
			true_sum[i] = float(y_true[mask].mean())
			counts[i] = int(mask.sum())
	return ReliabilityResult(edges, pred_sum, true_sum, counts)


def split_by_eras(seasons: np.ndarray) -> dict[str, np.ndarray]:
	# Returns masks for eras
	masks: dict[str, np.ndarray] = {}
	masks["pre_2012"] = seasons < 2012
	masks["2012_2021"] = (seasons >= 2012) & (seasons <= 2021)
	masks["2022_2024"] = (seasons >= 2022) & (seasons <= 2024)
	masks["2025_plus"] = seasons >= 2025
	return masks
