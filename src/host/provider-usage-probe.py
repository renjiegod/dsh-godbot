"""Read official CLI quota fields without a prompt, raw transcript or credential export."""
import datetime
import json
import math
import sys
import time


def safe_number(value, low=0, high=None):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value >= low and (high is None or value <= high))


def unix_time(value):
    if safe_number(value, 1, 253402300799):
        return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat()
    return None


def codex_limits(account, send, response):
    if account.get("type") != "chatgpt":
        return {"status": "unavailable", "reason": "unsupported"}
    email = account.get("email")
    owner = {"email": email, "accountKey": json.dumps([email, account.get("workspaceName")]) if email else None}
    send({"id": 3, "method": "account/rateLimits/read"})
    info = response(3)
    send({"id": 4, "method": "account/read", "params": {"refreshToken": False}})
    confirmed = response(4)
    if not isinstance(confirmed, dict) or confirmed.get("account") != account:
        return {"status": "unavailable", "reason": "identity-changed"}
    if not isinstance(info, dict):
        return {"status": "unavailable", "reason": "source-unavailable", **owner}
    # Workspace names need not be unique. When provided, the backend quota
    # account ID is part of the cache owner and takes precedence over its label.
    if isinstance(info.get("accountId"), str) and info["accountId"]:
        owner["accountKey"] = json.dumps([email, account.get("workspaceName"), info["accountId"]])
    primary = info.get("rateLimits") or {}
    buckets = dict(info.get("rateLimitsByLimitId") or {})
    if isinstance(primary, dict) and primary:
        buckets.setdefault(primary.get("limitId") or "codex", primary)
    windows = []
    for bucket_id, bucket in list(buckets.items())[:128]:
        if not isinstance(bucket, dict) or not isinstance(bucket_id, str):
            continue
        name = bucket.get("limitName") or bucket_id
        for key, suffix in (("primary", "主要窗口"), ("secondary", "次要窗口")):
            item = bucket.get(key)
            if not isinstance(item, dict):
                continue
            used = item.get("usedPercent")
            if not safe_number(used, 0, 100):
                continue
            duration = item.get("windowDurationMins")
            windows.append({"id": bucket_id + "/" + key, "label": str(name) + " · " + suffix,
                            "usedPercent": used, "remainingPercent": 100 - used,
                            "windowMinutes": duration if safe_number(duration, 1) else None,
                            "resetsAt": unix_time(item.get("resetsAt"))})
    credits = primary.get("credits") if isinstance(primary, dict) else None
    wallet = None
    if isinstance(credits, dict):
        wallet = {k: credits[k] for k in ("hasCredits", "unlimited") if isinstance(credits.get(k), bool)}
        amount = credits.get("balance")
        if isinstance(amount, str) and len(amount) <= 32:
            try:
                if safe_number(float(amount)):
                    wallet["balance"] = float(amount)
            except ValueError:
                pass
    return {"status": "available" if windows or wallet else "unavailable", "reason": None if windows or wallet else "not-reported",
            "windows": windows, "credits": wallet or None, "plan": primary.get("planType") or account.get("planType"), **owner}


# All arbitrary TUI text, session paths, conversations and OAuth material stay outside the result.
QUOTA_HOOK = """
import json, os, re, sys, tempfile, time
from pathlib import Path
try:
    item = json.loads(sys.stdin.buffer.read(262145))
    if item.get('product') == 'antigravity':
        buckets = {}
        for name, row in list((item.get('quota') or {}).items())[:128]:
            if isinstance(row, dict) and isinstance(name, str) and len(name) <= 96:
                buckets[name] = {k: row[k] for k in ('remaining_fraction', 'remaining_amount', 'reset_time', 'reset_in_seconds', 'disabled') if k in row and isinstance(row[k],(float,int,bool,str)) and len(str(row[k])) <= 64}
        raw = item.get('email')
        email = raw if isinstance(raw,str) and len(raw) <= 254 and re.fullmatch(r'[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+',raw) else None
        plan = item.get('plan_tier')
        safe = {'email':email, 'authenticating': item.get('agent_state') == 'authenticating', 'quota':buckets,
                'plan':plan if isinstance(plan,str) and len(plan)<=80 else None, 'observedAt':time.time()}
        dest = Path(sys.argv[1])
        with tempfile.NamedTemporaryFile(mode='w',dir=dest.parent,delete=False) as out:
            json.dump(safe,out)
        os.replace(out.name,dest)
except (OSError, TypeError, ValueError, AttributeError):
    pass
print('Godbot')
"""


def agy_limits(info, final):
    email = info.get("email")
    windows = []
    for name, bucket in (info.get("quota") or {}).items():
        fraction = bucket.get("remaining_fraction")
        amount = bucket.get("remaining_amount")
        disabled = bucket.get("disabled") is True
        if not safe_number(fraction, 0, 1) and not safe_number(amount) and not disabled:
            continue
        remaining = round(fraction * 100, 8) if safe_number(fraction, 0, 1) else None
        resets = bucket.get("reset_time")
        if not resets and safe_number(bucket.get("reset_in_seconds")):
            resets = unix_time(info["observedAt"] + bucket["reset_in_seconds"])
        windows.append({"id": name, "label": name, "usedPercent": round(100 - remaining, 8) if remaining is not None else None,
                        "remainingPercent": remaining, "remainingAmount": amount if safe_number(amount) else None,
                        "resetsAt": resets, "disabled": disabled})
    if windows and email:
        return {"status": "available", "email": email, "plan": info.get("plan"), "windows": windows}
    if final:
        return {"status": "unavailable", "email": email, "reason": "not-reported" if email else "source-unavailable"}
    return None


if __name__ == "__main__":
    try:
        # Both programs are selected by the Host and shipped together into an isolated account.
        helpers = {"__name__": "godbot_provider_status"}
        exec(compile(sys.argv[3], "<godbot-provider-status>", "exec"), helpers)
        kind, program = sys.argv[1:3]
        if kind == "codex":
            result = helpers["codex"](program, read_limits=codex_limits)
        elif kind == "antigravity":
            result = helpers["antigravity"](program, hook_source=QUOTA_HOOK, read_quota=agy_limits)
        else:
            result = {"status": "unavailable", "reason": "unsupported"}
    except (OSError, ValueError, TypeError, AttributeError, KeyError, OverflowError):
        result = {"status": "unavailable", "reason": "source-unavailable"}
    print(json.dumps(result))
