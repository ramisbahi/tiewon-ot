"""Freeze pregame spread buckets from an nflverse games.csv, excluding 2026.
Usage: python modeling/train_pregame.py /path/to/games.csv
"""
import csv, hashlib, json, math, sys
from pathlib import Path
source = Path(sys.argv[1])
rows = [r for r in csv.DictReader(source.open()) if r['game_type'] == 'REG'
        and 2017 <= int(r['season']) <= 2025 and r['overtime'] in ('0','1') and r['spread_line']]
def fit(data):
    rate = sum(int(r['overtime']) for r in data) / len(data)
    bins = []
    for low, high in [(-1,3),(3,7),(7,40)]:
        group = [r for r in data if low < abs(float(r['spread_line'])) <= high]
        n, count = len(group), sum(int(r['overtime']) for r in group)
        bins.append(dict(maxSpread=high, games=n, overtimeGames=count, probability=(count+100*rate)/(n+100)))
    return rate,bins
train=[r for r in rows if int(r['season'])<=2023]
test=[r for r in rows if int(r['season'])>=2024]
prior,buckets=fit(train)
def metrics(use_spread):
    pairs=[(next(b['probability'] for b in buckets if abs(float(r['spread_line']))<=b['maxSpread']) if use_spread else prior,int(r['overtime'])) for r in test]
    return sum((p-y)**2 for p,y in pairs)/len(pairs),sum(-y*math.log(p)-(1-y)*math.log(1-p) for p,y in pairs)/len(pairs)
brier,loss=metrics(True); flat_brier,flat_loss=metrics(False)
rate,bins=fit(rows)
result=dict(version='pregame-spread-buckets-v1',source='https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv',sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),seasons=[2017,2025],games=len(rows),overtimeGames=sum(int(r['overtime']) for r in rows),baseline=rate,shrinkageGames=100,bins=bins,validation=dict(trainSeasons=[2017,2023],testSeasons=[2024,2025],testGames=len(test),brierSpread=brier,brierFlat=flat_brier,logLossSpread=loss,logLossFlat=flat_loss),notes='Historical closing-spread buckets; live pregame quotes can differ. Small holdout improvement, not a calibrated sportsbook OT price. One 2017-2025 regular-season game lacks a usable spread. No 2026 outcomes used.')
Path(__file__).resolve().parents[1].joinpath('web/lib/pregame-baseline.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
