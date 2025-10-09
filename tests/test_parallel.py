from __future__ import annotations

from tiewon_ot.state import LiveState, Possession
from tiewon_ot.sim import simulate_overtime_prob, simulate_overtime_prob_parallel, SimulatorConfig


def test_parallel_close_to_serial():
	state = LiveState(
		score_diff=0,
		quarter=4,
		seconds_remaining=90,
		possession=Possession.HOME,
		down=3,
		distance=5,
		yardline_own=50,
		timeouts_home=1,
		timeouts_away=1,
		home_two_pt_available=True,
		away_two_pt_available=True,
		closing_spread=0.0,
	)
	cfg = SimulatorConfig()
	serial = simulate_overtime_prob(state, num_simulations=10000, random_seed=123, config=cfg)
	parallel = simulate_overtime_prob_parallel(state, num_simulations=10000, workers=4, random_seed=123, config=cfg)
	assert abs(serial - parallel) < 0.05
