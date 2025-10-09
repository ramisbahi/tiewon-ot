from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator


class Possession(str, Enum):
	HOME = "home"
	AWAY = "away"


class PatPending(str, Enum):
	NONE = "none"
	XP = "xp"
	TWO = "two"


class LiveState(BaseModel):
	# Score is home - away
	score_diff: int = Field(..., description="Home score minus away score")
	quarter: int = Field(..., ge=1, le=4, description="Regulation quarter (1-4)")
	seconds_remaining: int = Field(..., ge=0, le=15 * 60, description="Seconds remaining in current quarter")
	possession: Possession = Field(..., description="Current possession team")
	# Down-distance/field position in yards relative to possessing team's own goal line
	down: int = Field(..., ge=1, le=4)
	distance: int = Field(..., ge=0, le=99)
	yardline_own: int = Field(..., ge=1, le=99, description="Yards from own goal line (1=own 1, 50=midfield)")
	# Timeouts
	timeouts_home: int = Field(..., ge=0, le=3)
	timeouts_away: int = Field(..., ge=0, le=3)
	# Two-point try availability
	home_two_pt_available: bool = True
	away_two_pt_available: bool = True
	# Pre-game strength prior (home negative implies home favored by N points)
	closing_spread: float = Field(0.0, description="Home closing spread (home negative when favored)")
	# Optional context
	kicker_strength_home: Optional[float] = Field(None, description="Home kicker adj (positive better)")
	kicker_strength_away: Optional[float] = Field(None, description="Away kicker adj (positive better)")
	weather_adj: Optional[float] = Field(None, description="Global weather adjustment for kicking/plays (- bad, + good)")
	# Post-TD PAT pending state
	pat_pending: PatPending = PatPending.NONE

	@field_validator("seconds_remaining")
	@classmethod
	def _validate_seconds_remaining(cls, v: int) -> int:
		return v

	@property
	def time_remaining_game(self) -> int:
		quarters_left = 4 - self.quarter
		return quarters_left * 15 * 60 + self.seconds_remaining
