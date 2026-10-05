#!/usr/bin/env python3
"""Offline regression suite for the web_search lane passthrough monitor."""

import contextlib
import io
import json
import unittest
import urllib.error
from unittest import mock

import websearch_lane_probe as probe


class ClassifierTests(unittest.TestCase):
    def assert_exit(self, status, body_text, body_json, expected_exit):
        verdict, _ = probe.classify(status, body_text, body_json)
        self.assertEqual(probe.EXIT_FOR[verdict], expected_exit)

    def test_exact_manifest_drop_payload_exits_three(self):
        self.assert_exit(
            400,
            '{"type":"error","error":{"type":"invalid_request_error",'
            '"message":"Tool \'web_search\' not found in provided tools"}}',
            None,
            3,
        )

    def test_inline_200_manifest_drop_exits_three(self):
        body = {"content": [{"type": "text", "text": "Tool 'web_search' not found in provided tools"}]}
        self.assert_exit(200, json.dumps(body), body, 3)

    def test_silent_memory_answer_exits_three(self):
        body = {"content": [{"type": "text", "text": "HTTP Semantics"}]}
        self.assert_exit(200, json.dumps(body), body, 3)

    def test_healthy_tool_round_trip_exits_zero(self):
        body = {
            "content": [
                {"type": "server_tool_use", "name": "web_search"},
                {"type": "web_search_tool_result", "content": [{"url": "https://example.test"}]},
                {"type": "text", "text": "HTTP Semantics"},
            ]
        }
        self.assert_exit(200, json.dumps(body), body, 0)

    def test_search_error_is_inconclusive_exit_four(self):
        body = {
            "content": [
                {"type": "server_tool_use", "name": "web_search"},
                {
                    "type": "web_search_tool_result",
                    "content": {
                        "type": "web_search_tool_result_error",
                        "error_code": "max_uses_exceeded",
                    },
                },
            ]
        }
        self.assert_exit(200, json.dumps(body), body, 4)

    def test_quota_error_is_inconclusive_exit_four(self):
        self.assert_exit(429, '{"error":{"message":"all credentials cooling"}}', None, 4)

    def test_empty_200_envelope_is_inconclusive_not_a_page(self):
        self.assert_exit(200, "{}", {}, 4)

    def test_empty_content_array_is_inconclusive_not_a_page(self):
        body = {"stop_reason": "max_tokens", "content": []}
        self.assert_exit(200, json.dumps(body), body, 4)

    def test_unparseable_200_body_is_inconclusive_not_a_page(self):
        self.assert_exit(200, "<html>502 from an intermediary</html>", None, 4)

    def test_non_list_content_is_inconclusive_and_does_not_raise(self):
        self.assert_exit(200, '{"content":1}', {"content": 1}, 4)

    def test_truncated_turn_is_inconclusive_not_a_page(self):
        body = {
            "stop_reason": "max_tokens",
            "content": [{"type": "text", "text": "Let me search for"}],
        }
        self.assert_exit(200, json.dumps(body), body, 4)

    def test_refusal_is_inconclusive_not_a_page(self):
        body = {"stop_reason": "refusal", "content": [{"type": "text", "text": "I can't."}]}
        self.assert_exit(200, json.dumps(body), body, 4)

    def test_completed_turn_answering_from_memory_still_pages(self):
        """The silent-drop signal must survive the inconclusive-envelope guards."""
        body = {"stop_reason": "end_turn", "content": [{"type": "text", "text": "HTTP Semantics"}]}
        self.assert_exit(200, json.dumps(body), body, 3)

    def test_search_completing_at_the_token_limit_still_passes(self):
        body = {
            "stop_reason": "max_tokens",
            "content": [
                {"type": "server_tool_use", "name": "web_search"},
                {"type": "web_search_tool_result", "content": [{"url": "https://example.test"}]},
            ],
        }
        self.assert_exit(200, json.dumps(body), body, 0)


class ProbeRequestTests(unittest.TestCase):
    @mock.patch("urllib.request.urlopen")
    def test_request_declares_and_forces_web_search(self, urlopen):
        response = mock.MagicMock()
        response.status = 200
        response.read.return_value = json.dumps(
            {
                "content": [
                    {"type": "server_tool_use", "name": "web_search"},
                    {"type": "web_search_tool_result", "content": []},
                ]
            }
        ).encode()
        urlopen.return_value.__enter__.return_value = response

        verdict, _, _ = probe.probe("https://lane.invalid", "claude-sonnet-5", "canary")

        self.assertEqual(probe.EXIT_FOR[verdict], 0)
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://lane.invalid/v1/messages")
        payload = json.loads(request.data)
        self.assertEqual(
            payload["tools"],
            [{"type": "web_search_20250305", "name": "web_search", "max_uses": 1}],
        )
        self.assertEqual(payload["tool_choice"], {"type": "tool", "name": "web_search"})


class ScheduledMonitorTests(unittest.TestCase):
    def setUp(self):
        self.env = {
            "CLIPROXY_API_KEY": "direct-canary",
            "OMNIROUTE_API_KEY": "router-canary",
            "PAPERCLIP_API_URL": "https://paperclip.invalid/api",
            "PAPERCLIP_API_KEY": "paperclip-canary",
            "PAPERCLIP_TASK_ID": "issue-123",
            "PAPERCLIP_RUN_ID": "run-123",
        }

    def test_schedule_covers_the_direct_cliproxy_lane(self):
        lanes = probe.scheduled_lanes()
        self.assertEqual(
            [(lane.base_url, lane.model, lane.api_key_env) for lane in lanes],
            [("http://cliproxy:8317", "claude-sonnet-5", "CLIPROXY_API_KEY")],
        )

    def test_retired_omniroute_lane_is_not_scheduled(self):
        """Owner rule 2026-09-13: everything but Hindsight goes direct to CLIProxy.

        The cutover completed that move, so a verdict on the router lane
        measures a route no fleet traffic takes. Re-adding it would reintroduce
        a standing exit-4/5 row that is not a health signal. This pin is what
        makes putting it back a deliberate act rather than an accident.
        """
        for lane in probe.scheduled_lanes():
            self.assertNotIn("router.example.net", lane.base_url)
            self.assertNotEqual(lane.api_key_env, "OMNIROUTE_API_KEY")
            self.assertNotEqual(lane.secret_key, "omniroute_api_key")
            self.assertFalse(
                lane.model.startswith("cliproxy/"),
                f"{lane.model} is an OmniRoute-namespaced id; the direct lane "
                "takes a bare model id",
            )
        self.assertIn(
            "OmniRoute :: cliproxy/claude-sonnet-5", probe.RETIRED_SCHEDULED_LANES
        )

    def test_environment_cannot_redirect_a_scheduled_lane_or_its_credential(self):
        """A stale deployment setting must not aim a live key at another host.

        OMNIROUTE_BASE_URL is a live name in this repo with a different default
        (omniroute_combo_cli.sh uses 127.0.0.1:20128), so honouring it here
        would risk probing the wrong lane.
        """
        hostile = dict(self.env)
        hostile.update(
            {
                "CLIPROXY_BASE_URL": "https://staging.example",
                "OMNIROUTE_BASE_URL": "https://staging.example",
                "WEBSEARCH_CLIPROXY_KEY_ENV": "PAPERCLIP_API_KEY",
                "WEBSEARCH_OMNIROUTE_KEY_ENV": "PAPERCLIP_API_KEY",
            }
        )
        for lane in probe.scheduled_lanes():
            self.assertNotIn("staging.example", lane.base_url)
            self.assertNotEqual(lane.api_key_env, "PAPERCLIP_API_KEY")
            self.assertNotEqual(
                probe.resolve_api_key(lane, hostile), hostile["PAPERCLIP_API_KEY"]
            )

    @mock.patch.object(probe, "post_board_alarm")
    @mock.patch.object(probe, "probe")
    def test_scheduled_run_sends_no_credential_to_an_overridden_host(self, fake_probe, _alarm):
        fake_probe.return_value = ("PASS", "served", {"content": []})
        hostile = dict(self.env)
        hostile["CLIPROXY_BASE_URL"] = "https://staging.example"
        hostile["WEBSEARCH_CLIPROXY_KEY_ENV"] = "PAPERCLIP_API_KEY"

        self.assertEqual(probe.main(["--scheduled", "--json"], hostile), 0)

        targets = [call.args[0] for call in fake_probe.call_args_list]
        secrets = [call.args[2] for call in fake_probe.call_args_list]
        self.assertEqual(targets, ["http://cliproxy:8317"])
        self.assertNotIn("paperclip-canary", secrets)

    def test_dead_credential_selector_overrides_are_named_not_silent(self):
        self.assertEqual(
            probe.warn_ignored_overrides({"WEBSEARCH_OMNIROUTE_KEY_ENV": "PAPERCLIP_API_KEY"}),
            ["WEBSEARCH_OMNIROUTE_KEY_ENV"],
        )
        self.assertEqual(probe.warn_ignored_overrides(self.env), [])

    @mock.patch.object(probe, "post_board_alarm")
    @mock.patch.object(probe, "probe")
    def test_all_healthy_exits_zero_without_board_alarm(self, fake_probe, fake_alarm):
        fake_probe.return_value = ("PASS", "served", {"content": []})
        self.assertEqual(probe.main(["--scheduled", "--json"], self.env), 0)
        fake_alarm.assert_not_called()

    @mock.patch.object(probe, "post_board_alarm")
    @mock.patch.object(probe, "probe")
    def test_manifest_drop_exits_three_and_posts_board_alarm(self, fake_probe, fake_alarm):
        fake_probe.return_value = ("MANIFEST_DROP", "tool missing", {"content": []})
        self.assertEqual(probe.main(["--scheduled", "--json"], self.env), 3)
        fake_alarm.assert_called_once()
        results = fake_alarm.call_args.args[0]
        self.assertEqual([result.verdict for result in results], ["MANIFEST_DROP"])

    @mock.patch.object(probe, "post_board_alarm")
    @mock.patch.object(probe, "probe")
    def test_other_error_exits_four_and_does_not_page(self, fake_probe, fake_alarm):
        fake_probe.return_value = ("OTHER_ERROR", "quota cooling", None)
        self.assertEqual(probe.main(["--scheduled", "--json"], self.env), 4)
        fake_alarm.assert_not_called()

    def test_manifest_drop_outranks_an_inconclusive_lane(self):
        """Precedence is a property of aggregate_exit, not of the schedule size.

        Pinning it here keeps it covered however many lanes the schedule holds,
        including today's single-lane set.
        """
        drop = probe.Result("a", "MANIFEST_DROP", "tool missing")
        inconclusive = probe.Result("b", "OTHER_ERROR", "transport")
        healthy = probe.Result("c", "PASS", "served")
        self.assertEqual(probe.aggregate_exit([drop, inconclusive]), 3)
        self.assertEqual(probe.aggregate_exit([inconclusive, drop]), 3)
        self.assertEqual(probe.aggregate_exit([healthy, inconclusive]), 4)
        self.assertEqual(probe.aggregate_exit([healthy]), 0)

    @mock.patch.object(probe, "post_board_alarm")
    def test_missing_lane_key_is_exit_four_without_page(self, fake_alarm):
        env = dict(self.env)
        del env["CLIPROXY_API_KEY"]
        with mock.patch.object(probe, "probe", return_value=("PASS", "served", {"content": []})), \
             mock.patch.object(probe, "fetch_run_secret", return_value=None):
            self.assertEqual(probe.main(["--scheduled", "--json"], env), 4)
        fake_alarm.assert_not_called()

    @mock.patch.object(probe, "fetch_run_secret", return_value="fetched-direct-key")
    @mock.patch.object(probe, "probe", return_value=("PASS", "served", {"content": []}))
    def test_direct_key_falls_back_to_bound_paperclip_secret(self, fake_probe, fetch_secret):
        """CLIPROXY_API_KEY is not guaranteed in an agent run.

        Without the fallback the one remaining scheduled lane resolves None and
        returns OTHER_ERROR every cycle -- the whole probe stops measuring while
        looking like a quota blip.
        """
        env = dict(self.env)
        del env["CLIPROXY_API_KEY"]
        result = probe.run_lane(probe.scheduled_lanes()[0], env)
        self.assertEqual(probe.EXIT_FOR[result.verdict], 0)
        fetch_secret.assert_called_once_with("cliproxy_agent_api_key", env)
        # The fetched value must actually reach probe(), not just be resolved.
        self.assertEqual(fake_probe.call_args.args[0], "http://cliproxy:8317")
        self.assertEqual(fake_probe.call_args.args[2], "fetched-direct-key")

    def test_every_scheduled_lane_names_a_run_secret(self):
        self.assertTrue(probe.scheduled_lanes(), "the schedule must not be empty")
        for lane in probe.scheduled_lanes():
            self.assertTrue(lane.secret_key, f"{lane.label} has no run-secret fallback")

    def test_caller_supplied_lane_cannot_pull_a_bound_secret(self):
        """Single-lane mode takes its host from the caller, so it gets no secret."""
        lane = probe.Lane(
            label="attacker", base_url="https://staging.example",
            model="claude-sonnet-5", api_key_env="NOT_SET_ANYWHERE",
        )
        self.assertIsNone(lane.secret_key)
        with mock.patch.object(probe, "fetch_run_secret") as fetch_secret:
            self.assertIsNone(probe.resolve_api_key(lane, self.env))
        fetch_secret.assert_not_called()

    @mock.patch.object(probe, "post_board_alarm")
    def test_a_lane_that_never_measures_is_loud_not_silent(self, _alarm):
        """Exit 4 is shared with quota blips, so a blind lane needs its own signal."""
        env = dict(self.env)
        del env["CLIPROXY_API_KEY"]
        stderr = io.StringIO()
        with mock.patch.object(probe, "probe", return_value=("PASS", "served", {"content": []})), \
             mock.patch.object(probe, "fetch_run_secret", return_value=None), \
             contextlib.redirect_stderr(stderr):
            self.assertEqual(probe.main(["--scheduled", "--json"], env), 4)
        self.assertIn("BLIND LANE", stderr.getvalue())
        self.assertIn("direct cliproxy :: claude-sonnet-5", stderr.getvalue())
        self.assertIn("cliproxy_agent_api_key", stderr.getvalue())

    @mock.patch.object(probe, "post_board_alarm")
    def test_a_healthy_lane_is_never_called_blind(self, _alarm):
        stderr = io.StringIO()
        with mock.patch.object(probe, "probe", return_value=("PASS", "served", {"content": []})), \
             contextlib.redirect_stderr(stderr):
            self.assertEqual(probe.main(["--scheduled", "--json"], self.env), 0)
        self.assertNotIn("BLIND LANE", stderr.getvalue())

    @mock.patch("urllib.request.urlopen")
    def test_board_alarm_posts_to_current_issue_with_run_id(self, urlopen):
        response = mock.MagicMock()
        response.status = 201
        urlopen.return_value.__enter__.return_value = response
        results = [probe.Result("direct cliproxy :: claude-sonnet-5", "MANIFEST_DROP", "tool missing")]

        probe.post_board_alarm(results, self.env)

        request = urlopen.call_args.args[0]
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 60)
        self.assertEqual(request.full_url, "https://paperclip.invalid/api/issues/issue-123/comments")
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(headers["x-paperclip-run-id"], "run-123")
        body = json.loads(request.data)
        self.assertIn("MANIFEST_DROP", body["body"])
        self.assertIn("direct cliproxy :: claude-sonnet-5", body["body"])


class FetchRunSecretTests(unittest.TestCase):
    def setUp(self):
        self.env = {
            "PAPERCLIP_API_URL": "https://paperclip.invalid/api",
            "PAPERCLIP_API_KEY": "paperclip-canary",
        }

    @mock.patch("urllib.request.urlopen")
    def test_value_fetch_posts_json_body(self, urlopen):
        response = mock.MagicMock()
        response.read.return_value = json.dumps({"value": "lane-key"}).encode()
        urlopen.return_value.__enter__.return_value = response

        self.assertEqual(
            probe.fetch_run_secret("cliproxy_agent_api_key", self.env), "lane-key"
        )

        request = urlopen.call_args.args[0]
        self.assertEqual(
            request.full_url,
            "https://paperclip.invalid/api/agents/me/secrets/"
            "cliproxy_agent_api_key/value",
        )
        self.assertEqual(json.loads(request.data), {})
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(headers["content-type"], "application/json")

    @mock.patch("urllib.request.urlopen")
    def test_denial_is_loud_and_leaks_no_value(self, urlopen):
        urlopen.side_effect = urllib.error.HTTPError(
            "https://paperclip.invalid/api/agents/me/secrets/"
            "cliproxy_agent_api_key/value",
            403,
            "Forbidden",
            {},
            io.BytesIO(b'{"error":"Route not allowed"}'),
        )
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertIsNone(
                probe.fetch_run_secret("cliproxy_agent_api_key", self.env)
            )
        logged = stderr.getvalue()
        self.assertIn("fetch_run_secret cliproxy_agent_api_key: HTTP 403", logged)
        self.assertNotIn("lane-key", logged)
        self.assertNotIn("paperclip-canary", logged)

    @mock.patch("urllib.request.urlopen")
    def test_transport_failure_is_loud_not_silent(self, urlopen):
        urlopen.side_effect = OSError("connection reset")
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertIsNone(
                probe.fetch_run_secret("cliproxy_agent_api_key", self.env)
            )
        self.assertIn("fetch_run_secret cliproxy_agent_api_key: OSError", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
