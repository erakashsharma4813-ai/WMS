"""Seeded random numbers, bit-identical to the starter-kit engine (mulberry32).

Every process draws from its own stream so that changing one input does not
reshuffle the random numbers of unrelated processes (common random numbers).
"""

import math

MASK = 0xFFFFFFFF
STREAMS = ("arrivals", "gate", "pick", "put", "load", "docs", "prod")


def _i32(value: int) -> int:
    value &= MASK
    return value - 0x100000000 if value & 0x80000000 else value


def _imul(a: int, b: int) -> int:
    return _i32((a & MASK) * (b & MASK))


def mulberry(seed: int):
    state = _i32(seed)

    def draw() -> float:
        nonlocal state
        a = _i32(state + 0x6D2B79F5)
        state = a
        t = _imul(a ^ ((a & MASK) >> 15), 1 | a)
        t = _i32(t + _imul(t ^ ((t & MASK) >> 7), 61 | t)) ^ t
        return ((t ^ ((t & MASK) >> 14)) & MASK) / 4294967296

    return draw


def streams(seed: int) -> dict:
    return {name: mulberry((seed * 7919 + index * 104729) & MASK) for index, name in enumerate(STREAMS)}


def triangular(u: float, low_mode_high) -> float:
    a, c, b = low_mode_high
    f = (c - a) / (b - a)
    if u < f:
        return a + math.sqrt(u * (b - a) * (c - a))
    return b - math.sqrt((1 - u) * (b - a) * (b - c))


def exponential(u: float, mean: float) -> float:
    return -math.log(1 - u) * mean
