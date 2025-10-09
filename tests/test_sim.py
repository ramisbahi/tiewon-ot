from __future__ import annotations

import numpy as np

from tiewon_ot.state import LiveState, Possession
from tiewon_ot.sim import simulate_overtime_prob, SimulatorConfig


def make_state(score_diff: int, seconds: int) -> LiveState:
	return LiveState(
		score_diff=score_diff,
		quarter=4,
		seconds_remaining=seconds,
		possession=Possession.HOME,
		down=4,
		distance=10,
		yardline_own=40,
		timeouts_home=1,
		timeouts_away=1,
		home_two_pt_available=True,
		away_two_pt_available=True,
		closing_spread=0.0,
	)


def test_deterministic_seed():
	state = make_state(0, 90)
	cfg = SimulatorConfig()
	p1 = simulate_overtime_prob(state, num_simulations=5000, random_seed=42, config=cfg)
	p2 = simulate_overtime_prob(state, num_simulations=5000, random_seed=42, config=cfg)
	assert abs(p1 - p2) < 1e-9


def test_monotonic_score_diff_near_end():
	cfg = SimulatorConfig()
	state_tied = make_state(0, 30)
	state_down3 = make_state(-3, 30)
	p_tied = simulate_overtime_prob(state_tied, num_simulations=8000, random_seed=1, config=cfg)
	p_down3 = simulate_overtime_prob(state_down3, num_simulations=8000, random_seed=1, config=cfg)
	assert p_tied >= p_down3
