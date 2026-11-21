"""Read a native CLI's public account status. Only status and validated email leave this process."""
import json
import os
import re
import select
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def address(value):
    if isinstance(value, str) and len(value) <= 254 and re.fullmatch(r"[^\s@\x00-\x1f<>]+@[^\s@\x00-\x1f<>]+\.[^\s@\x00-\x1f<>]+", value):
        return value
    return None


def status(value, email=None):
    return {"status": value, "email": address(email) if value == "signed-in" else None}


def stop(pid):
    reaped = False

    def child_exited():
        nonlocal reaped
        if not reaped:
            try:
                reaped = os.waitpid(pid, os.WNOHANG)[0] == pid
            except ChildProcessError:
                reaped = True
        return reaped

    def group_exited():
        try:
            os.killpg(pid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            pass
        # Darwin sometimes returns EPERM when the last member of a closing
        # PTY group exits. Inspect only process-group IDs and states. Reaping
        # the leader alone would not establish that its descendants are gone.
        rows = subprocess.run(["/bin/ps", "-A", "-o", "pgid=", "-o", "stat="],
                              capture_output=True, text=True, timeout=2, check=True)
        return not any(group == str(pid) and not state.startswith("Z")
                       for group, state in (line.split() for line in rows.stdout.splitlines() if line.strip()))

    for sig, timeout in ((signal.SIGTERM, 0.7), (signal.SIGKILL, 2)):
        if child_exited() and group_exited():
            return
        try:
            os.killpg(pid, sig)
        except (PermissionError, ProcessLookupError):
            if not child_exited():
                try:
                    os.kill(pid, sig)
                except (PermissionError, ProcessLookupError):
                    pass  # completion is checked below, including the group
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if child_exited() and group_exited():
                return
            time.sleep(0.03)
    raise OSError("could not confirm native CLI process cleanup")


def claude(program):
    result = subprocess.run([program, "auth", "status", "--json"], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=12)
    account = json.loads(result.stdout)
    if account.get("loggedIn") is True:
        return status("signed-in", account.get("email"))
    return status("signed-out" if account.get("loggedIn") is False else "unavailable")


def codex(program, read_limits=None):
    proc = subprocess.Popen([program, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, start_new_session=True)
    buffer = bytearray()
    deadline = time.monotonic() + 15

    def send(message):
        proc.stdin.write(json.dumps(message).encode() + b"\n")
        proc.stdin.flush()

    def response(query):
        while time.monotonic() < deadline:
            while b"\n" in buffer:
                line, _, remaining = buffer.partition(b"\n")
                buffer[:] = remaining
                message = json.loads(line)
                if message.get("id") == query:
                    return message.get("result")
            if len(buffer) > 1024 * 1024:
                break
            if select.select([proc.stdout], [], [], max(0, deadline - time.monotonic()))[0]:
                chunk = os.read(proc.stdout.fileno(), 32768)
                if not chunk:
                    break
                buffer.extend(chunk)
        return None

    try:
        send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "godbot", "version": "1"}}})
        if not isinstance(response(1), dict):
            return status("unavailable")
        send({"method": "initialized"})
        send({"id": 2, "method": "account/read", "params": {"refreshToken": False}})
        info = response(2)
        if not isinstance(info, dict) or "account" not in info:
            return status("unavailable")
        account = info["account"]
        if isinstance(account, dict) and read_limits:
            return read_limits(account, send, response)
        if isinstance(account, dict) and account.get("type") in ("chatgpt", "apiKey", "amazonBedrock", "gcp"):
            return status("signed-in", account.get("email") if account["type"] == "chatgpt" else None)
        return status("signed-out" if account is None and info.get("requiresOpenaiAuth") is True else "unavailable")
    finally:
        stop(proc.pid)
        proc.stdin.close()
        proc.stdout.close()


# AGY's documented statusLine command receives the display identity on stdin.
# Never persist the status payload or forward TUI, shell or provider output.
STATUS_HOOK = """
import json, os, re, sys, tempfile
from pathlib import Path
try:
    item = json.loads(sys.stdin.buffer.read(262145))
    value = item.get('email')
    if item.get('product') == 'antigravity':
        email = value if (isinstance(value, str) and len(value) <= 254
            and re.fullmatch(r'[^\\s@\\x00-\\x1f<>]+@[^\\s@\\x00-\\x1f<>]+\\.[^\\s@\\x00-\\x1f<>]+', value)) else None
        dest = Path(sys.argv[1])
        with tempfile.NamedTemporaryFile(mode='w', dir=dest.parent, delete=False) as out:
            json.dump({'email': email, 'authenticating': item.get('agent_state') == 'authenticating'}, out)
        os.replace(out.name, dest)
except (OSError, TypeError, ValueError):
    pass
print('Godbot')
"""


def antigravity(program, timeout=18, hook_source=STATUS_HOOK, read_quota=None):
    import fcntl
    import pty
    import struct
    import termios
    with tempfile.TemporaryDirectory(prefix="godbot-account-") as folder:
        result = Path(folder, "identity")
        hook = Path(folder, "status.py")
        hook.write_text(hook_source, encoding="utf-8")
        command = shlex.join([sys.executable, "-I", str(hook), str(result)])
        settings = {"statusLine": {"type": "command", "command": command, "enabled": True}}
        pid, terminal = pty.fork()
        if pid == 0:
            try:
                fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
                os.environ.update(TERM="xterm-256color", NO_COLOR="1")
                os.execv(program, [program, "--settings", json.dumps(settings)])
            finally:
                os._exit(126)
        try:
            until = time.monotonic() + timeout
            last_text = b""
            explicit_sign_out = False
            auth_prompt = False
            fields = {}
            while time.monotonic() < until:
                if result.exists():
                    fields = json.loads(result.read_text())
                    email = address(fields.get("email"))
                    if read_quota:
                        observed = read_quota(fields, False)
                        if observed:
                            return observed
                    elif email:
                        return status("signed-in", email)
                    auth_prompt = fields.get("authenticating") is True
                if select.select([terminal], [], [], 0.15)[0]:
                    try:
                        chunk = os.read(terminal, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    sample = last_text + chunk.lower()
                    if b"not signed in" in sample:
                        explicit_sign_out = True
                    last_text = sample[-16:]
            # An empty email or startup/authentication splash alone does not
            # establish logout. Give the CLI its full window to load an identity.
            expired = time.monotonic() >= until
            if explicit_sign_out and auth_prompt and expired:
                return status("signed-out")
            return read_quota(fields, True) if read_quota else status("unavailable")
        finally:
            os.close(terminal)
            # macOS can block a terminating TUI on outstanding terminal output.
            # Release its PTY master before waiting for the process group to exit.
            stop(pid)


if __name__ == "__main__":
    try:
        observed = {"antigravity": antigravity, "codex": codex, "claude": claude}[sys.argv[1]](sys.argv[2])
    except (OSError, ValueError, TypeError, KeyError, AttributeError, subprocess.SubprocessError):
        observed = status("unavailable")
    print(json.dumps(observed))
