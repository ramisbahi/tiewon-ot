"""Train TieWon's three-way end-of-regulation outcome model."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, roc_auc_score

from train_model import READ_COLUMNS, _fold_for_game, feature_matrix, serialize_tree

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
OUTPUT = ROOT / "web" / "lib" / "outcome-model-data.json"
METRICS = ROOT / "modeling" / "outcome-metrics.json"
CLASS_NAMES = ["away_ahead", "tied", "home_ahead"]


def load_states() -> pd.DataFrame:
    frames = []
    for path in sorted(DATA.glob("play_by_play_*.csv")):
        raw = pd.read_csv(path, usecols=READ_COLUMNS, low_memory=False)
        games = raw.groupby("game_id", sort=False).agg(
            max_quarter=("qtr", "max"), home_final=("home_score", "last"), away_final=("away_score", "last")
        )
        games["outcome"] = np.where(
            games.max_quarter >= 5, 1,
            np.where(games.home_final > games.away_final, 2, np.where(games.home_final < games.away_final, 0, 1)),
        )
        valid = raw[
            raw.qtr.between(1, 4) & raw.posteam.notna() & raw.home_team.notna()
            & raw.game_seconds_remaining.notna() & raw.down.between(1, 4)
            & raw.ydstogo.notna() & raw.yardline_100.between(1, 99)
            & raw.score_differential.notna()
        ].copy()
        valid["minute_bin"] = (valid.game_seconds_remaining // 60).astype(int)
        early = (valid[valid.game_seconds_remaining > 300]
                 .sort_values(["game_id", "game_seconds_remaining"], ascending=[True, False])
                 .drop_duplicates(["game_id", "minute_bin"]))
        sampled = pd.concat([early, valid[valid.game_seconds_remaining <= 300]], ignore_index=True)
        sampled = sampled.drop_duplicates(["game_id", "play_id"])
        sampled["outcome"] = sampled.game_id.map(games.outcome).astype(int)
        frames.append(sampled)
    states = pd.concat(frames, ignore_index=True)
    states["sample_weight"] = 1 / states.groupby("game_id").game_id.transform("size")
    return states


def classifier(seed: int) -> GradientBoostingClassifier:
    return GradientBoostingClassifier(
        n_estimators=160, learning_rate=0.04, max_depth=3, min_samples_leaf=55,
        subsample=0.86, random_state=seed, loss="log_loss",
    )


def normalize(rows: np.ndarray) -> np.ndarray:
    return rows / rows.sum(axis=1, keepdims=True).clip(1e-12)


def main() -> None:
    frame = load_states()
    X = feature_matrix(frame)
    y = frame.outcome.to_numpy(int)
    weights = frame.sample_weight.to_numpy(float)
    groups = frame.game_id.astype(str).to_numpy()
    folds = 5
    fold_ids = np.array([_fold_for_game(game_id, folds) for game_id in groups])
    oof = np.zeros((len(frame), 3), dtype=float)
    for fold in range(folds):
        train = fold_ids != fold
        test = ~train
        fitted = classifier(910 + fold)
        fitted.fit(X[train], y[train], sample_weight=weights[train])
        oof[test] = fitted.predict_proba(X[test])

    calibrators = []
    calibrated = np.zeros_like(oof)
    for class_index in range(3):
        calibrator = IsotonicRegression(out_of_bounds="clip", y_min=0.0005, y_max=0.999)
        calibrator.fit(oof[:, class_index], y == class_index, sample_weight=weights)
        calibrated[:, class_index] = calibrator.predict(oof[:, class_index])
        calibrators.append(calibrator)
    calibrated = normalize(calibrated)

    tie_target = (y == 1).astype(int)
    late = frame.game_seconds_remaining.to_numpy() <= 300
    metrics = {
        "validation": "Five-fold, game-grouped out-of-fold validation",
        "games": int(frame.game_id.nunique()), "snapshots": int(len(frame)),
        "all_states": {
            "multiclass_log_loss": float(log_loss(y, calibrated, sample_weight=weights, labels=[0, 1, 2])),
            "accuracy": float(accuracy_score(y, calibrated.argmax(axis=1), sample_weight=weights)),
            "tie_brier": float(brier_score_loss(tie_target, calibrated[:, 1], sample_weight=weights)),
            "tie_auc": float(roc_auc_score(tie_target, calibrated[:, 1], sample_weight=weights)),
        },
        "final_five_minutes": {
            "multiclass_log_loss": float(log_loss(y[late], calibrated[late], sample_weight=weights[late], labels=[0, 1, 2])),
            "accuracy": float(accuracy_score(y[late], calibrated[late].argmax(axis=1), sample_weight=weights[late])),
            "tie_brier": float(brier_score_loss(tie_target[late], calibrated[late, 1], sample_weight=weights[late])),
            "tie_auc": float(roc_auc_score(tie_target[late], calibrated[late, 1], sample_weight=weights[late])),
        },
    }

    final = classifier(1025)
    final.fit(X, y, sample_weight=weights)
    priors = final.init_.class_prior_
    export = {
        "version": "1.0.0", "target": "Away ahead / tied / home ahead at end of regulation",
        "classNames": CLASS_NAMES, "baseScores": [float(math.log(value)) for value in priors],
        "learningRate": float(final.learning_rate),
        "trees": [[serialize_tree(tree) for tree in stage] for stage in final.estimators_],
        "calibration": [
            {"x": np.round(item.X_thresholds_, 10).tolist(), "y": np.round(item.y_thresholds_, 10).tolist()}
            for item in calibrators
        ],
        "trainingSummary": {"games": metrics["games"], "snapshots": metrics["snapshots"], **metrics["all_states"]},
    }
    OUTPUT.write_text(json.dumps(export, separators=(",", ":")))
    METRICS.write_text(json.dumps(metrics, indent=2) + "\n")
    print(json.dumps(metrics, indent=2))
    print(f"Exported {len(final.estimators_)} three-class stages to {OUTPUT}")


if __name__ == "__main__":
    main()
