#!/usr/bin/env python3
"""Offline tests for the standalone watchdog section readers.

No detector integration, credentials, network, or board writes. Numeric
coercion, malformed-row accounting and output hygiene use synthetic values.
"""

import gc
import json
import unittest

from watchdog.sections import SectionRead, read_float, read_int

NAN = float("nan")
INF = float("inf")
JUNK_SECTIONS = [5, 0, 2.5, True, False, "oops-sentinel", "", {}, {"x": 1}]


class ReadNumberTest(unittest.TestCase):
    def test_read_float_accepts_what_float_always_accepted(self):
        for value, want in [(1, 1.0), (0, 0.0), (-3, -3.0), (2.5, 2.5),
                            ("85", 85.0), (" 2.5 ", 2.5)]:
            with self.subTest(value=value):
                self.assertEqual(read_float(value), want)

    def test_read_float_rejects_what_passes_every_threshold_silently(self):
        for value in [None, True, False, "lots", "", "nan", "inf", [], {},
                      NAN, INF, float("-inf"), 10 ** 400]:
            with self.subTest(value=repr(value)[:20]):
                self.assertIsNone(read_float(value))

    def test_read_int_keeps_the_legacy_coercion(self):
        for value, want in [(3, 3), (0, 0), ("3", 3), (3.9, 3), (-2, -2)]:
            with self.subTest(value=value):
                self.assertEqual(read_int(value), want)

    def test_read_int_rejects_what_used_to_raise_or_lie(self):
        # int(float("inf")) raises OverflowError; True would read as 1.
        for value in [None, True, False, "many", "", "3.5", [], {}, NAN,
                      INF]:
            with self.subTest(value=repr(value)):
                self.assertIsNone(read_int(value))


class SectionReadTest(unittest.TestCase):
    def finding(self, detector, reason, severity, owner, route, evidence,
                suggested):
        return {"detector": detector, "reason": reason,
                "severity": severity, "owner": owner, "route": route,
                "evidence": evidence, "suggested": suggested}

    def unknown(self, read):
        return read.unknown(self.finding, "test_detector", "owner", "route")

    def test_absent_section_is_the_callers_call_not_a_complaint(self):
        read = SectionRead("agents", None)
        self.assertEqual(list(read), [])
        self.assertEqual(self.unknown(read), [])

    def test_clean_list_reports_nothing(self):
        read = SectionRead("agents", [{"a": 1}, {"b": 2}])
        self.assertEqual(list(read), [{"a": 1}, {"b": 2}])
        self.assertEqual(self.unknown(read), [])

    def test_mistyped_section_is_one_finding_naming_only_the_type(self):
        for value in JUNK_SECTIONS:
            with self.subTest(value=repr(value)):
                read = SectionRead("agents", value)
                self.assertEqual(list(read), [])
                (found,) = self.unknown(read)
                self.assertEqual(found["severity"], "unknown")
                self.assertEqual(found["reason"], "agents snapshot unreadable")
                self.assertEqual(found["evidence"],
                                 {"section": "agents",
                                  "found": type(value).__name__})
                self.assertNotIn("sentinel", json.dumps(found))

    def test_non_dict_rows_are_counted_once_and_never_echoed(self):
        rows = [{"ok": 1}, "row-sentinel", 7, None]
        read = SectionRead("agents", rows)
        self.assertEqual(list(read), [{"ok": 1}])
        (found,) = self.unknown(read)
        self.assertEqual(found["reason"], "agents rows unreadable")
        self.assertEqual(found["evidence"],
                         {"section": "agents", "rows": 4,
                          "unreadableRows": 3})
        self.assertNotIn("sentinel", json.dumps(found))

    def test_flag_counts_a_row_once_however_many_fields_are_bad(self):
        read = SectionRead("hosts", [{"a": 1}, {"b": 2}])
        for index, _row in enumerate(read):
            if index == 0:
                read.flag()
                read.flag()
        self.assertEqual(read.unreadable, 1)
        (found,) = read.unknown(self.finding, "test_detector", "owner", "route")
        self.assertEqual(found["evidence"]["unreadableRows"], 1)

    def test_equal_rows_are_counted_separately(self):
        row = {"a": 1}
        read = SectionRead("hosts", [row, row, row])
        for _row in read:
            read.flag()
        self.assertEqual(read.unreadable, 3)

    def test_flag_outside_iteration_is_a_programming_error(self):
        with self.assertRaises(RuntimeError):
            SectionRead("hosts", [{"a": 1}]).flag()

    def test_flagged_and_non_dict_rows_share_one_finding(self):
        read = SectionRead("hosts", [{"a": 1}, "x"])
        for _row in read:
            read.flag()
        (found,) = read.unknown(self.finding, "test_detector", "owner", "route")
        self.assertEqual(found["evidence"],
                         {"section": "hosts", "rows": 2, "unreadableRows": 2})

    def test_flag_after_exhaustion_is_a_programming_error(self):
        read = SectionRead("agents", [{"a": 1}])
        self.assertEqual(list(read), [{"a": 1}])
        with self.assertRaises(RuntimeError):
            read.flag()
        self.assertEqual(read.unreadable, 0)

    def test_flag_after_iterator_close_is_a_programming_error(self):
        read = SectionRead("agents", [{"a": 1}, {"b": 2}])
        iterator = iter(read)
        self.assertEqual(next(iterator), {"a": 1})
        read.flag()
        iterator.close()
        with self.assertRaises(RuntimeError):
            read.flag()
        self.assertEqual(read.unreadable, 1)

    def test_delayed_finalization_does_not_clear_later_iterator(self):
        read = SectionRead("agents", [{"a": 1}, {"b": 2}])
        was_enabled = gc.isenabled()
        gc.disable()
        current = None
        try:
            abandoned = iter(read)
            self.assertEqual(next(abandoned), {"a": 1})
            cycle = [abandoned]
            cycle.append(cycle)
            del abandoned, cycle
            # The first iterator is unreachable before the next pass starts.
            current = iter(read)
            self.assertEqual(next(current), {"a": 1})
            gc.collect()
            read.flag()
            self.assertEqual(next(current), {"b": 2})
            read.flag()
            self.assertEqual(list(current), [])
            self.assertEqual(read.unreadable, 2)
            with self.assertRaises(RuntimeError):
                read.flag()
        finally:
            if current is not None:
                current.close()
            if was_enabled:
                gc.enable()

    def test_flagged_rows_never_echo_field_keys_or_values(self):
        read = SectionRead("agents", [{"private-field-sentinel": "value-sentinel"}])
        for _row in read:
            read.flag()
        (found,) = self.unknown(read)
        self.assertEqual(found["evidence"],
                         {"section": "agents", "rows": 1, "unreadableRows": 1})
        self.assertNotIn("sentinel", json.dumps(found))


if __name__ == "__main__":
    unittest.main()
