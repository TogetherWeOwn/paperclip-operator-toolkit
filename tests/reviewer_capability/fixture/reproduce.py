"""Opt-in probes of deliberately defective review inputs, not a CI test suite.

Run with python3 -I -B; two assertion failures are the fixture answer key.
Do not repair the fixtures to improve a reviewer's evaluation score.
"""

import importlib.util
from pathlib import Path
import sys
import unittest


# -I excludes the script directory from sys.path. Load only our two fixed files.
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("quota", HERE / "quota.py")
quota = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quota)
sys.modules["quota"] = quota
spec = importlib.util.spec_from_file_location("quota_fixture_request", HERE / "request.py")
request = importlib.util.module_from_spec(spec)
spec.loader.exec_module(request)


class ReservationContract(unittest.TestCase):
    def test_exact_limit_is_accepted_and_saved(self):
        writes = []
        result = request.reserve_request(7, 3, 10, writes.append)
        self.assertEqual((result, writes), ({"accepted": True, "used": 10}, [10]))

    def test_failed_save_is_not_an_accepted_reservation(self):
        def unavailable_store(value):
            raise OSError("synthetic unavailable store")

        with self.assertRaises(OSError):
            request.reserve_request(7, 2, 10, unavailable_store)

    def test_negative_amount_is_rejected_before_any_save(self):
        writes = []
        with self.assertRaises(ValueError):
            request.reserve_request(7, -3, 10, writes.append)
        self.assertEqual(writes, [])

    def test_below_limit_is_accepted_and_saved(self):
        writes = []
        result = request.reserve_request(7, 2, 10, writes.append)
        self.assertEqual((result, writes), ({"accepted": True, "used": 9}, [9]))

    def test_above_limit_is_refused_without_a_save(self):
        writes = []
        result = request.reserve_request(7, 4, 10, writes.append)
        self.assertEqual((result, writes), ({"accepted": False, "used": 7}, []))


if __name__ == "__main__":
    unittest.main(verbosity=2)
