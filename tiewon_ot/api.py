from __future__ import annotations

from typing import Optional

from .state import LiveState
from .sim import simulate_overtime_prob, SimulatorConfig


def overtime_probability(
	state: LiveState,
	num_simulations: int = 50000,
	random_seed: Optional[int] = None,
	config: Optional[SimulatorConfig] = None,
) -> float:
	return simulate_overtime_prob(state, num_simulations=num_simulations, random_seed=random_seed, config=config)
