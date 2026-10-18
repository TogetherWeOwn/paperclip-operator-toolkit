"""Opt-in snapshot section readers for the platform watchdog.

A malformed section or row must not become a silent clean baseline. Callers
can use SectionRead to collect dictionary rows and aggregate unreadable input
into an ``unknown`` finding. Missing sections remain the caller's decision.
The existing public detectors are not rewired by this standalone helper.

Pure functions and one small class: no I/O, no clock, no network. Findings
are built by a caller-supplied function, so this module does not import any
detectors. Aggregate evidence carries counts and the section label only,
never a row, field value or key from the snapshot.
"""

from __future__ import annotations

import math


def read_float(value):
    """Return ``value`` as a finite float, or None when it is unreadable.

    ``float()`` alone accepts booleans, NaN and Infinity. Those are not
    valid snapshot measurements here, even when Python can coerce them.
    """
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def read_int(value):
    """Return ``value`` as an int, or None when it is unreadable.

    Keeps ordinary ``int()`` coercion (``3.9`` -> 3, ``"3"`` -> 3), except
    booleans are not counts and nonfinite floats must not raise.
    """
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


class SectionRead:
    """Rows of one snapshot section, plus a tally of unreadable input.

    ``None`` means the section is absent: no rows and no complaint here.
    Anything else that is not a list is a mistyped section. Iterating yields
    dictionary rows only; non-object rows count as unreadable.

    A caller that cannot judge a row calls ``flag()`` while looping over it.
    Flagging the same row twice counts once, and equal rows count separately.
    ``unknown()`` turns the tally into at most one finding per section.
    Iterate sequentially; simultaneous iterators share the current-row state.
    """

    def __init__(self, section, value):
        self.section = section
        self._absent = value is None
        self._is_list = isinstance(value, list)
        self.found = None if self._is_list or self._absent else type(value).__name__
        rows = value if self._is_list else []
        self.rows = [row for row in rows if isinstance(row, dict)]
        self.total = len(rows)
        self._at = None
        self._iterator_owner = None
        self._flagged = set()
        self._non_dict = self.total - len(self.rows)

    def __iter__(self):
        owner = object()
        self._iterator_owner = owner
        try:
            for position, row in enumerate(self.rows):
                self._at = position
                yield row
        finally:
            # An abandoned iterator may be finalized during a later pass.
            if self._iterator_owner is owner:
                self._at = None
                self._iterator_owner = None

    def flag(self):
        """Mark the row currently being read as unreadable."""
        if self._at is None:
            raise RuntimeError("flag() is only valid while iterating rows")
        self._flagged.add(self._at)

    @property
    def unreadable(self):
        return self._non_dict + len(self._flagged)

    def unknown(self, finding, detector, owner, route):
        """Return this section's ``unknown`` finding as a list of 0 or 1.

        ``finding`` is the caller's builder. Mistyped sections and unreadable
        rows are reported without reflecting their contents.
        """
        if self.found is not None:
            return [finding(
                detector, f"{self.section} snapshot unreadable", "unknown",
                owner, route,
                {"section": self.section, "found": self.found},
                f"supply {self.section} as a list of objects; "
                "no verdict without it")]
        if self.unreadable:
            return [finding(
                detector, f"{self.section} rows unreadable", "unknown",
                owner, route,
                {"section": self.section, "rows": self.total,
                 "unreadableRows": self.unreadable},
                f"fix the {self.section} adapter; the unreadable rows "
                "got no verdict")]
        return []
