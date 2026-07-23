#!/usr/bin/env python3
"""Submit one explicit, meaningful Hermes personality moment to ClawBoard."""
from __future__ import annotations
import argparse, json, os, urllib.error, urllib.request


def post_json(api: str, api_key: str, payload: dict) -> tuple[int, dict]:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    request = urllib.request.Request(
        api.rstrip("/") + "/nim-status/update", data=data, method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json", "x-api-key": api_key,
                 "User-Agent": "HermesPersonalityStatus/1"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try: body = json.load(error)
        except Exception: body = {"success": False, "error": "HTTP error"}
        return error.code, body


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default=os.getenv("CLAWBOARD_API_URL"))
    parser.add_argument("--api-key", default=os.getenv("CLAWBOARD_API_KEY"))
    parser.add_argument("--event-id", required=True)
    parser.add_argument("--completed-at", required=True)
    parser.add_argument("--mood", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--manual", action="store_true")
    parser.add_argument("--avatar-url")
    parser.add_argument("--avatar-attempted", action="store_true")
    parser.add_argument("--avatar-failure", choices=("image_generate_failed", "delivery_failed"))
    args = parser.parse_args(argv)
    if not args.api or not args.api_key:
        parser.error("--api/CLAWBOARD_API_URL and --api-key/CLAWBOARD_API_KEY are required")
    if not args.manual and not args.avatar_attempted:
        parser.error("meaningful statuses require --avatar-attempted")
    if args.avatar_url and args.avatar_failure:
        parser.error("--avatar-url and --avatar-failure are mutually exclusive")
    if args.avatar_attempted and not args.avatar_url and not args.avatar_failure:
        parser.error("a failed avatar attempt requires --avatar-failure")
    payload = {
        "mood": args.mood, "status_text": args.text, "avatar_url": args.avatar_url,
        "author": "Hermes", "author_harness": "hermes",
        "trigger": "manual" if args.manual else "meaningful_goal_completed",
        "event_id": args.event_id, "event_completed_at": args.completed_at,
        "avatar_attempted": args.avatar_attempted, "avatar_failure": args.avatar_failure,
    }
    status, result = post_json(args.api, args.api_key, payload)
    # Output is deliberately bounded and never echoes prose, credentials, or source content.
    print(json.dumps({"http_status": status, "success": result.get("success", False),
                      "outcome": result.get("outcome"), "reason": result.get("reason"),
                      "status_id": (result.get("status") or {}).get("id")}, sort_keys=True))
    return 0 if status in (200, 201) and result.get("outcome") in ("created", "duplicate") else 1


if __name__ == "__main__":
    raise SystemExit(main())
