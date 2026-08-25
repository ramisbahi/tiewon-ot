# TieWon

TieWon is a live NFL dashboard for one question: **what is the probability that the score is tied when regulation ends?**

The site polls the ESPN public scoreboard during games and scores every state in the browser. When no games are live, an editable scenario lab can play forward any preset or custom state.

The simulator shows two independent views:

- a calibrated binary model specialized for the probability regulation ends tied;
- a separately validated three-way model for away ahead / tied / home ahead; and
- a 10,000-run Monte Carlo check fitted to 26,352 historical drives, including a rule-aware final win/loss/tie result.

Pending extra points and two-point tries are explicit states. Overtime can use the legacy regular-season format, the 2025+ both-teams-possession format, or postseason rules.

## Run the website

```bash
cd web
npm install
npm run dev
```

Open `http://localhost:3000`.

## Production build

```bash
cd web
npm run build
```

## Tests

```bash
cd web
npm test
```

The regression suite covers pending tries, score geometry, end-of-regulation boundaries, every custom-state playback path, normalized three-way outcomes, deterministic simulation, and postseason no-draw behavior.

## Retrain the model

Place nflverse `play_by_play_YYYY.csv` files in `data/`, then run:

```bash
python modeling/train_model.py
```

The tie trainer:

- creates one representative snapshot per game-minute plus every valid snap in the final five minutes;
- gives each game equal total weight;
- predicts whether the game reaches overtime;
- validates with five folds grouped by game to prevent state leakage;
- calibrates probabilities with isotonic regression; and
- exports a compact tree ensemble to `web/lib/model-data.json` for browser inference.

`modeling/train_outcome_model.py` fits the separate three-way regulation model. `modeling/train_simulator.py` extracts empirical outcome and duration distributions from historical drives for Monte Carlo.

## Current model

- Seasons: 2021–2025
- Games: 1,217
- Game states: 87,972
- Overtime games: 76
- Final-five-minute ROC AUC: 0.885
- Final-five-minute Brier score: 0.0547, versus 0.0645 for the legacy fallback

The large raw play-by-play files are intentionally ignored by Git. The deployed site needs only the 69 KB exported model.

See [AUDIT.md](AUDIT.md) for what was removed, what changed, and remaining limitations.
