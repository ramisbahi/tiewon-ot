#!/usr/bin/env python3
"""Train and export TieWon's browser-side overtime probability model.

The model predicts whether a game reaches overtime from a regulation play state.
It is trained from nflverse play-by-play snapshots and exported as compact JSON
so the website can score live and hypothetical states without a Python server.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score


FEATURE_NAMES = [
    "seconds_remaining",
    "time_fraction",
    "fourth_quarter",
    "final_two_minutes",
    "score_diff_offense",
    "home_score_diff",
    "home_leads",
    "home_trails",
    "absolute_score_diff",
    "is_tied",
    "one_score_game",
    "offense_trails",
    "field_goal_ties",
    "touchdown_can_tie",
    "down",
    "yards_to_go",
    "yards_to_goal",
    "in_field_goal_range",
    "offense_timeouts",
    "defense_timeouts",
    "home_possession",
    "time_score_pressure",
]
BINARY_FEATURE_NAMES = [name for name in FEATURE_NAMES if name not in {"home_score_diff", "home_leads", "home_trails"}]

READ_COLUMNS = [
    "game_id",
    "play_id",
    "season",
    "qtr",
    "game_seconds_remaining",
    "down",
    "ydstogo",
    "yardline_100",
    "score_differential",
    "posteam",
    "home_team",
    "posteam_timeouts_remaining",
    "defteam_timeouts_remaining",
    "play_type",
    "home_score",
    "away_score",
]


def _fold_for_game(game_id: str, folds: int) -> int:
    digest = hashlib.sha1(game_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % folds


def load_snapshots(data_dir: Path) -> tuple[pd.DataFrame, dict[str, float]]:
    frames: list[pd.DataFrame] = []
    overtime_games: set[str] = set()
    final_ties = 0
    overtime_count = 0
    game_count = 0

    for path in sorted(data_dir.glob("play_by_play_*.csv")):
        raw = pd.read_csv(path, usecols=READ_COLUMNS, low_memory=False)
        game_summary = raw.groupby("game_id", sort=False).agg(
            max_quarter=("qtr", "max"),
            home_score=("home_score", "last"),
            away_score=("away_score", "last"),
        )
        season_ot = set(game_summary.index[game_summary.max_quarter >= 5])
        overtime_games.update(season_ot)
        overtime_count += len(season_ot)
        game_count += len(game_summary)
        final_ties += int(
            (
                (game_summary.max_quarter >= 5)
                & (game_summary.home_score == game_summary.away_score)
            ).sum()
        )

        valid = raw[
            (raw.qtr.between(1, 4))
            & raw.posteam.notna()
            & raw.home_team.notna()
            & raw.game_seconds_remaining.notna()
            & raw.down.between(1, 4)
            & raw.ydstogo.notna()
            & raw.yardline_100.between(1, 99)
            & raw.score_differential.notna()
        ].copy()

        # One representative state per minute early, every valid snap in the
        # last five minutes. This limits within-game duplication while keeping
        # the sharp late-game probability changes the product is built for.
        valid["minute_bin"] = (valid.game_seconds_remaining // 60).astype(int)
        early = (
            valid[valid.game_seconds_remaining > 300]
            .sort_values(["game_id", "game_seconds_remaining"], ascending=[True, False])
            .drop_duplicates(["game_id", "minute_bin"])
        )
        late = valid[valid.game_seconds_remaining <= 300]
        sampled = pd.concat([early, late], ignore_index=True).drop_duplicates(
            ["game_id", "play_id"]
        )
        sampled["reached_overtime"] = sampled.game_id.isin(overtime_games).astype(int)
        frames.append(sampled)

    if not frames:
        raise FileNotFoundError(f"No play_by_play_*.csv files found in {data_dir}")

    snapshots = pd.concat(frames, ignore_index=True)
    # Every game receives equal total training weight.
    per_game_rows = snapshots.groupby("game_id").game_id.transform("size")
    snapshots["sample_weight"] = 1.0 / per_game_rows

    # Conservative beta prior centered at 5% for P(final draw | overtime).
    conditional_final_tie = (final_ties + 1.0) / (overtime_count + 20.0)
    stats = {
        "games": int(game_count),
        "overtime_games": int(overtime_count),
        "regulation_overtime_rate": overtime_count / max(1, game_count),
        "final_ties": int(final_ties),
        "conditional_final_tie_rate": conditional_final_tie,
        "snapshots": int(len(snapshots)),
    }
    return snapshots, stats


def feature_matrix(frame: pd.DataFrame, feature_names: list[str] = FEATURE_NAMES) -> np.ndarray:
    seconds = frame.game_seconds_remaining.clip(0, 3600).astype(float)
    diff = frame.score_differential.clip(-28, 28).astype(float)
    abs_diff = diff.abs()
    down = frame.down.fillna(1).clip(1, 4).astype(float)
    to_go = frame.ydstogo.fillna(10).clip(1, 30).astype(float)
    to_goal = frame.yardline_100.fillna(75).clip(1, 99).astype(float)
    offense_timeouts = frame.posteam_timeouts_remaining.fillna(3).clip(0, 3).astype(float)
    defense_timeouts = frame.defteam_timeouts_remaining.fillna(3).clip(0, 3).astype(float)
    home_possession = (frame.posteam == frame.home_team).astype(float)
    home_diff = np.where(home_possession == 1, diff, -diff)

    values = {
        "seconds_remaining": seconds,
        "time_fraction": seconds / 3600.0,
        "fourth_quarter": (frame.qtr == 4).astype(float),
        "final_two_minutes": (seconds <= 120).astype(float),
        "score_diff_offense": diff,
        "home_score_diff": home_diff,
        "home_leads": (home_diff > 0).astype(float),
        "home_trails": (home_diff < 0).astype(float),
        "absolute_score_diff": abs_diff,
        "is_tied": (diff == 0).astype(float),
        "one_score_game": (abs_diff <= 8).astype(float),
        "offense_trails": (diff < 0).astype(float),
        "field_goal_ties": (diff == -3).astype(float),
        "touchdown_can_tie": diff.isin([-8.0, -7.0, -6.0]).astype(float),
        "down": down,
        "yards_to_go": to_go,
        "yards_to_goal": to_goal,
        "in_field_goal_range": (to_goal <= 40).astype(float),
        "offense_timeouts": offense_timeouts,
        "defense_timeouts": defense_timeouts,
        "home_possession": home_possession,
        "time_score_pressure": abs_diff / np.sqrt(seconds + 30.0),
    }
    return np.column_stack([values[name] for name in feature_names])


def build_classifier(seed: int) -> GradientBoostingClassifier:
    return GradientBoostingClassifier(
        n_estimators=140,
        learning_rate=0.045,
        max_depth=3,
        min_samples_leaf=55,
        subsample=0.86,
        random_state=seed,
        loss="log_loss",
    )


def legacy_probability(frame: pd.DataFrame) -> np.ndarray:
    """Mean of the old fallback heuristic, evaluated as P(reaches OT)."""
    score = frame.score_differential.abs().to_numpy(float)
    quarter = frame.qtr.to_numpy(float)
    quarter_seconds = np.mod(frame.game_seconds_remaining.to_numpy(float), 900.0)
    quarter_seconds[(frame.game_seconds_remaining.to_numpy(float) > 0) & (quarter_seconds == 0)] = 900
    base = np.full(len(frame), 0.03)
    base += np.where(score == 0, 0.25, 0)
    base += np.where((score > 0) & (score <= 3), 0.20, 0)
    base += np.where((score > 3) & (score <= 7), 0.10, 0)
    base += np.where((score > 7) & (score <= 14), 0.03, 0)
    time_factor = quarter_seconds / 3600.0
    base *= 0.3 + 0.7 * time_factor
    base *= np.where(quarter >= 4, 2.0, np.where(quarter >= 3, 1.5, 1.0))
    base *= 0.8 + 0.4 * time_factor
    return np.clip(base, 0.005, 0.6)


def serialize_tree(estimator) -> dict:
    tree = estimator.tree_
    return {
        "childrenLeft": tree.children_left.tolist(),
        "childrenRight": tree.children_right.tolist(),
        "feature": tree.feature.tolist(),
        "threshold": np.round(tree.threshold, 8).tolist(),
        "value": np.round(tree.value[:, 0, 0], 10).tolist(),
    }


def train_and_export(data_dir: Path, output_path: Path, metrics_path: Path) -> None:
    frame, data_stats = load_snapshots(data_dir)
    X = feature_matrix(frame, BINARY_FEATURE_NAMES)
    y = frame.reached_overtime.to_numpy(int)
    weights = frame.sample_weight.to_numpy(float)
    groups = frame.game_id.astype(str).to_numpy()

    folds = 5
    fold_ids = np.array([_fold_for_game(game_id, folds) for game_id in groups])
    oof = np.zeros(len(frame), dtype=float)
    for fold in range(folds):
        train = fold_ids != fold
        test = ~train
        model = build_classifier(710 + fold)
        model.fit(X[train], y[train], sample_weight=weights[train])
        oof[test] = model.predict_proba(X[test])[:, 1]

    calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.0005, y_max=0.995)
    calibrator.fit(oof, y, sample_weight=weights)
    calibrated_oof = calibrator.predict(oof)
    baseline = np.full(len(y), np.average(y, weights=weights))
    legacy = legacy_probability(frame)

    def metric_set(prob: np.ndarray) -> dict[str, float]:
        return {
            "brier": float(brier_score_loss(y, prob, sample_weight=weights)),
            "log_loss": float(log_loss(y, prob, sample_weight=weights, labels=[0, 1])),
            "roc_auc": float(roc_auc_score(y, prob, sample_weight=weights)),
        }

    late_mask = (frame.game_seconds_remaining <= 300).to_numpy()
    late_weights = weights[late_mask]
    late_y = y[late_mask]
    late_prob = calibrated_oof[late_mask]
    late_legacy = legacy[late_mask]
    late_baseline = np.full(len(late_y), np.average(late_y, weights=late_weights))

    metrics = {
        "validation": "Five-fold, game-grouped out-of-fold validation",
        "data": data_stats,
        "all_game_states": {
            "tiewon_v2": metric_set(calibrated_oof),
            "legacy_fallback": metric_set(legacy),
            "constant_baseline": metric_set(baseline),
        },
        "final_five_minutes": {
            "tiewon_v2": {
                "brier": float(brier_score_loss(late_y, late_prob, sample_weight=late_weights)),
                "log_loss": float(log_loss(late_y, late_prob, sample_weight=late_weights, labels=[0, 1])),
                "roc_auc": float(roc_auc_score(late_y, late_prob, sample_weight=late_weights)),
            },
            "legacy_fallback": {
                "brier": float(brier_score_loss(late_y, late_legacy, sample_weight=late_weights)),
                "log_loss": float(log_loss(late_y, late_legacy, sample_weight=late_weights, labels=[0, 1])),
                "roc_auc": float(roc_auc_score(late_y, late_legacy, sample_weight=late_weights)),
            },
            "constant_baseline": {
                "brier": float(brier_score_loss(late_y, late_baseline, sample_weight=late_weights)),
                "log_loss": float(log_loss(late_y, late_baseline, sample_weight=late_weights, labels=[0, 1])),
                "roc_auc": 0.5,
            },
        },
    }

    final_model = build_classifier(825)
    final_model.fit(X, y, sample_weight=weights)
    prior = float(final_model.init_.class_prior_[1])
    base_score = math.log(prior / (1.0 - prior))
    export = {
        "version": "2.0.0",
        "target": "Probability the score is tied at the end of regulation",
        "trainedSeasons": sorted(int(v) for v in frame.season.dropna().unique()),
        "featureNames": BINARY_FEATURE_NAMES,
        "baseScore": base_score,
        "learningRate": float(final_model.learning_rate),
        "trees": [serialize_tree(tree[0]) for tree in final_model.estimators_],
        "calibration": {
            "x": np.round(calibrator.X_thresholds_, 10).tolist(),
            "y": np.round(calibrator.y_thresholds_, 10).tolist(),
        },
        "conditionalFinalTieRate": data_stats["conditional_final_tie_rate"],
        "trainingSummary": {
            "games": data_stats["games"],
            "overtimeGames": data_stats["overtime_games"],
            "snapshots": data_stats["snapshots"],
            "oofBrier": metrics["all_game_states"]["tiewon_v2"]["brier"],
            "legacyBrier": metrics["all_game_states"]["legacy_fallback"]["brier"],
        },
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    metrics_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(export, separators=(",", ":")))
    metrics_path.write_text(json.dumps(metrics, indent=2) + "\n")
    print(json.dumps(metrics, indent=2))
    print(f"Exported {len(export['trees'])} trees to {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--output", type=Path, default=Path("web/lib/model-data.json"))
    parser.add_argument("--metrics", type=Path, default=Path("modeling/metrics.json"))
    args = parser.parse_args()
    train_and_export(args.data_dir, args.output, args.metrics)


if __name__ == "__main__":
    main()
