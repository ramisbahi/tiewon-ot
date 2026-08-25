"""Fit the compact empirical drive distributions used by the browser simulator."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
OUTPUT = ROOT / "web" / "lib" / "simulation-data.json"
USECOLS = [
    "game_id", "fixed_drive", "posteam", "qtr", "game_seconds_remaining",
    "fixed_drive_result", "drive_time_of_possession", "drive_start_yard_line",
]
FIELD_EDGES = [0, 20, 35, 50, 70, 100]
FIELD_LABELS = ["backed_up", "own_territory", "midfield", "plus_territory", "red_zone"]
RESULTS = ["Touchdown", "Field goal", "Safety", "Opp touchdown", "No score"]


def duration_seconds(value: object) -> float:
    try:
        minutes, seconds = str(value).split(":")
        return int(minutes) * 60 + int(seconds)
    except (ValueError, TypeError):
        return np.nan


def own_yard(row: pd.Series) -> float:
    try:
        side, number = str(row.drive_start_yard_line).split()
        yard = int(number)
        return yard if side == row.posteam else 100 - yard
    except (ValueError, TypeError):
        return 25


def normalized_result(value: object) -> str:
    result = str(value)
    return result if result in RESULTS[:-1] else "No score"


def quantiles(values: pd.Series) -> list[int]:
    clean = values.dropna().clip(1, 900)
    if clean.empty:
        return [120, 180, 240]
    return np.quantile(clean, np.linspace(0.01, 0.99, 49)).round().astype(int).tolist()


def main() -> None:
    frames = []
    for path in sorted(DATA.glob("play_by_play_*.csv")):
        plays = pd.read_csv(path, usecols=USECOLS, low_memory=False)
        drives = (plays.dropna(subset=["fixed_drive", "posteam"])
                  .sort_values(["game_id", "fixed_drive", "game_seconds_remaining"], ascending=[True, True, False])
                  .groupby(["game_id", "fixed_drive"], as_index=False).first())
        frames.append(drives)
    drives = pd.concat(frames, ignore_index=True)
    drives = drives[(drives.qtr <= 4) & drives.fixed_drive_result.notna()].copy()
    drives["own_yard"] = drives.apply(own_yard, axis=1).clip(1, 99)
    drives["field_bin"] = pd.cut(drives.own_yard, FIELD_EDGES, labels=FIELD_LABELS, include_lowest=True)
    drives["result"] = drives.fixed_drive_result.map(normalized_result)
    drives["duration"] = drives.drive_time_of_possession.map(duration_seconds)

    bins = {}
    for label in FIELD_LABELS:
        subset = drives[drives.field_bin == label]
        counts = subset.result.value_counts()
        total = max(1, int(counts.sum()))
        bins[label] = {
            "n": total,
            "outcomes": {result: float(counts.get(result, 0) / total) for result in RESULTS},
            "durations": {
                result: quantiles(subset.loc[subset.result == result, "duration"])
                for result in RESULTS
            },
        }

    attempts = pd.concat([
        pd.read_csv(path, usecols=["extra_point_attempt", "extra_point_result", "two_point_attempt", "two_point_conv_result"], low_memory=False)
        for path in sorted(DATA.glob("play_by_play_*.csv"))
    ], ignore_index=True)
    xp = attempts[attempts.extra_point_attempt == 1]
    two = attempts[attempts.two_point_attempt == 1]
    payload = {
        "version": "2021-2025-drive-v1",
        "games": int(drives.game_id.nunique()),
        "drives": int(len(drives)),
        "fieldEdges": FIELD_EDGES,
        "fieldLabels": FIELD_LABELS,
        "bins": bins,
        "tryRates": {
            "kick": float((xp.extra_point_result == "good").mean()),
            "two_point": float((two.two_point_conv_result == "success").mean()),
        },
    }
    OUTPUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"Wrote {OUTPUT} from {payload['drives']:,} drives")


if __name__ == "__main__":
    main()
