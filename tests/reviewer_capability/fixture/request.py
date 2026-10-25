"""Synthetic public entry point for the quota-review challenge."""

from quota import reserve


def reserve_request(used, amount, limit, save):
    if amount < 0:
        raise ValueError("amount must be nonnegative")
    return reserve(used, amount, limit, save)
