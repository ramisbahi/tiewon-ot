from __future__ import annotations

import os
from pathlib import Path

import numpy as np

from tiewon_ot.state import LiveState, Possession
from tiewon_ot.sim import SimulatorConfig, simulate_overtime_prob


def run_batch(state: LiveState, sims: int = 500, seed: int = 123) -> float:
	cfg = SimulatorConfig()
	return simulate_overtime_prob(state, num_simulations=sims, random_seed=seed, config=cfg, progress=False)


def mean_points_proxy(state: LiveState, sims: int = 200, seed: int = 123) -> float:
	# Proxy by running two sims with slightly different seeds and averaging final diffs magnitude; simple placeholder
	p_list = []
	for i in range(5):
		p_list.append(run_batch(state, sims=sims//5, seed=seed + i))
	return float(np.mean(p_list))


def test_midgame_equilibrium():
	state = LiveState(
		score_diff=0,
		quarter=2,
		seconds_remaining=8*60,
		possession=Possession.HOME,
		down=1,
		distance=10,
		yardline_own=25,
		timeouts_home=3,
		timeouts_away=3,
	)
	p = run_batch(state)
	assert 0.02 <= p <= 0.10


def test_blowout_q3_no_ot():
	state = LiveState(
		score_diff=21,
		quarter=3,
		seconds_remaining=5*60,
		possession=Possession.HOME,
		down=1,
		distance=10,
		yardline_own=25,
		timeouts_home=3,
		timeouts_away=3,
	)
	p = run_batch(state)
	assert p < 0.01


def test_late_tie_q4():
	state = LiveState(
		score_diff=0,
		quarter=4,
		seconds_remaining=2*60,
		possession=Possession.HOME,
		down=1,
		distance=10,
		yardline_own=25,
		timeouts_home=3,
		timeouts_away=3,
	)
	p = run_batch(state)
	assert 0.3 <= p <= 0.6


def test_down_fg_q4():
	state = LiveState(
		score_diff=-3,
		quarter=4,
		seconds_remaining=90,
		possession=Possession.HOME,
		down=1,
		distance=10,
		yardline_own=35,
		timeouts_home=1,
		timeouts_away=2,
	)
	p = run_batch(state)
	assert 0.08 <= p <= 0.22


def test_down_td_q4():
	state = LiveState(
		score_diff=-7,
		quarter=4,
		seconds_remaining=60,
		possession=Possession.HOME,
		down=1,
		distance=10,
		yardline_own=40,
		timeouts_home=2,
		timeouts_away=2,
	)
	p = run_batch(state)
	assert 0.02 <= p <= 0.08


def test_up_one_opp_ball():
	state = LiveState(
		score_diff=1,
		quarter=4,
		seconds_remaining=75,
		possession=Possession.AWAY,
		down=1,
		distance=10,
		yardline_own=25,
		timeouts_home=2,
		timeouts_away=2,
	)
	p = run_batch(state)
	assert p < 0.01


def test_kickoff_ot_rate():
	state = LiveState(
		score_diff=0,
		quarter=1,
		seconds_remaining=15*60,
		possession=Possession.HOME,
		down=1,
		distance=10,
		yardline_own=25,
		timeouts_home=3,
		timeouts_away=3,
	)
	p = run_batch(state, sims=1500, seed=7)
	assert 0.035 <= p <= 0.065
