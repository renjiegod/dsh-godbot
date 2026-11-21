"""Project the native Claude Code structured /usage control response. No prompt is sent."""
import datetime
import json
import math
import os
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time

PLANS = {"pro", "max", "team", "enterprise", "ultra", "free"}
WINDOWS = (
    ("five_hour", "5 小时", 300), ("seven_day", "7 天 · 所有模型", 10080),
    ("seven_day_opus", "Opus · 7 天", 10080), ("seven_day_sonnet", "Sonnet · 7 天", 10080),
    ("seven_day_oauth_apps", "OAuth 应用 · 7 天", 10080),
)
ACCOUNT_EMAIL = re.compile(r"[^\s@\x00-\x1f<>]+@[^\s@\x00-\x1f<>]+\.[^\s@\x00-\x1f<>]+")
MODEL = re.compile(r"(?:Claude )?(?:Opus|Sonnet|Haiku|Fable|Mythos)(?:[ -][0-9]+(?:\.[0-9]+){0,2})?", re.I)


def report(status, reason=None, email=None, plan=None, windows=None):
    return {"status": status, "reason": reason, "email": email, "plan": plan, "windows": windows or []}


def run(args, payload, deadline, cwd):
    # Bound both runtime and output. Nothing the CLI logs or reports verbatim
    # (MCP names, project information, user emails from other sources) is forwarded.
    with subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          start_new_session=True, cwd=cwd) as child:
        try:
            if payload:
                child.stdin.write(payload)
            child.stdin.close()
            output = bytearray()
            with selectors.DefaultSelector() as reader:
                reader.register(child.stdout, selectors.EVENT_READ)
                while len(output) < 1024 * 1024:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not reader.select(remaining):
                        raise TimeoutError()
                    chunk = os.read(child.stdout.fileno(), 32768)
                    if not chunk:
                        child.wait(timeout=max(0, deadline - time.monotonic()))
                        return output
                    output.extend(chunk)
            raise ValueError("size")
        finally:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


def account(program, cwd, deadline):
    document = json.loads(run([program, "auth", "status", "--json"], None, deadline, cwd))
    email = document.get("email")
    if document.get("loggedIn") is False:
        return False, None, None
    if document.get("loggedIn") is not True:
        return None, None, None
    if not isinstance(email, str) or len(email) > 254 or not ACCOUNT_EMAIL.fullmatch(email):
        email = None
    return True, email, document.get("orgId")


def window(item, key, label, minutes):
    if not isinstance(item, dict):
        return None
    used = item.get("utilization")
    if type(used) not in (float, int) or not math.isfinite(used) or not 0 <= used <= 100:
        return None
    reset = item.get("resets_at")
    stamp = None
    if isinstance(reset, str) and len(reset) <= 40:
        try:
            parsed = datetime.datetime.fromisoformat(reset.replace("Z", "+00:00"))
            if parsed.tzinfo:
                stamp = parsed.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        except (ValueError, OverflowError):
            pass
    return {"id": key, "label": label, "windowMinutes": minutes, "usedPercent": used, "resetsAt": stamp}


def project(data, email):
    if not isinstance(data, dict):
        return report("unavailable", "source-unavailable", email)
    plan = data.get("subscription_type")
    plan = plan.lower() if isinstance(plan, str) and plan.lower() in PLANS else None
    limits = data.get("rate_limits")
    if data.get("rate_limits_available") is not True or not isinstance(limits, dict):
        return report("unavailable", "not-reported", email, plan)
    rows = [row for key, label, minutes in WINDOWS
            for row in [window(limits.get(key), key, label, minutes)] if row]
    seen = {row["id"] for row in rows}
    scoped = limits.get("model_scoped")
    for entry in scoped[:32] if isinstance(scoped, list) else []:
        name = entry.get("display_name") if isinstance(entry, dict) else None
        if not isinstance(name, str) or not MODEL.fullmatch(name):
            continue
        key = "seven_day_" + re.sub(r"[^a-z0-9]+", "_", name.lower().removeprefix("claude "))
        row = window(entry, key, name + " · 7 天", 10080)
        if row and key not in seen:
            seen.add(key)
            rows.append(row)
    return report("available", email=email, plan=plan, windows=rows) if rows else report("unavailable", "not-reported", email, plan)


def probe(program):
    deadline = time.monotonic() + 24
    with tempfile.TemporaryDirectory(prefix="godbot-claude-usage-") as directory:
        before = account(program, directory, min(deadline, time.monotonic() + 6))
        if before[0] is False:
            return report("signed-out", "not-authenticated")
        if before[0] is not True or not before[1]:
            return report("unavailable", "not-reported")
        # Claude Code's SDK offers structured /usage without a user message.
        # skip_behaviors skips its optional transcript scan for recommendations.
        request = {"type": "control_request", "request_id": "godbot-quota",
                   "request": {"subtype": "get_usage", "skip_behaviors": True}}
        args = [program, "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
                "--safe-mode", "--no-session-persistence", "--strict-mcp-config", "--tools", ""]
        output = run(args, json.dumps(request).encode() + b"\n", deadline - 3, directory)
        data = None
        for line in output.splitlines():
            event = json.loads(line)
            if event.get("type") != "control_response":
                continue
            body = event.get("response", {})
            if body.get("request_id") == "godbot-quota" and body.get("subtype") == "success":
                data = body.get("response")
                break
        after = account(program, directory, deadline)
        if before != after:
            return report("unavailable", "identity-changed")
        return project(data, before[1])


if __name__ == "__main__":
    try:
        result = probe(sys.argv[-1])
    except (OSError, ValueError, TypeError, AttributeError, TimeoutError, subprocess.SubprocessError, IndexError):
        result = report("unavailable", "source-unavailable")
    print(json.dumps(result, ensure_ascii=False))
