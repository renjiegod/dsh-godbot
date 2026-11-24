"""Called over the account SSH channel. The host sends this program on argv."""
import json
import os
import pathlib
import re
import selectors
import signal
import subprocess
import sys


def reject(reason):
    sys.exit("GODBOT_SANDBOX: " + reason)


def check_identity(spec):
    if os.getuid() != spec["uid"] or pathlib.Path("/etc/machine-id").read_text().strip() != spec["machineId"]:
        reject("guest identity does not match the registered account")


def mount_path(value):
    return re.sub(r"\\([0-7]{3})", lambda escaped: chr(int(escaped[1], 8)), value)


def check_workspace(spec):
    root = pathlib.Path(spec["guestPath"])
    cwd = pathlib.Path(spec["guestCwd"])
    if root != root.resolve() or cwd != cwd.resolve() or (cwd != root and root not in cwd.parents) or not cwd.is_dir():
        reject("guest workspace directory does not match the approved path")
    found = False
    for line in pathlib.Path("/proc/self/mountinfo").read_text().splitlines():
        head, tail = line.split(" - ", 1)
        fields = head.split()
        target = pathlib.Path(mount_path(fields[4]))
        if target != root:
            if target in cwd.parents or target == cwd:
                if root in target.parents:
                    reject("nested guest mount shadows the approved workspace")
            continue
        fs, source, options = tail.split()[:3]
        if fs != spec["filesystem"] or mount_path(source) != spec["source"]:
            reject("guest workspace has a different mounted source")
        if ("ro" in fields[5].split(",") or "ro" in options.split(",")) != spec["readOnly"]:
            reject("guest workspace mount permissions have changed")
        found = True
    if not found:
        reject("approved guest workspace is not mounted")
    program = pathlib.Path(spec["program"])
    if not program.is_file() or not os.access(program, os.X_OK):
        reject("registered agent executable is unavailable")


def manager_environment():
    uid = os.getuid()
    path = "/run/user/" + str(uid)
    if not pathlib.Path(path + "/bus").is_socket():
        reject("guest systemd user manager is unavailable")
    env = os.environ.copy()
    env.update(XDG_RUNTIME_DIR=path, DBUS_SESSION_BUS_ADDRESS="unix:path=" + path + "/bus")
    return env


def stop_units(units, env):
    for unit in units:
        if not re.fullmatch(r"godbot-agent-[0-9a-f-]{36}\.service", unit):
            reject("invalid guest execution identifier")
        # Unloaded units are also stopped. Verify state after a possibly concurrent stop.
        subprocess.run(["systemctl", "--user", "stop", unit], env=env, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=9)
        result = subprocess.run(["systemctl", "--user", "show", unit, "-p", "ActiveState", "--value"],
                                env=env, capture_output=True, text=True, timeout=4)
        if result.stdout.strip() not in ("inactive", "failed"):
            reject("could not confirm guest process cleanup")


def execute(action, spec, unit, argv, env):
    terminal = action == "terminal"
    cmd = ["systemd-run", "--user", "--quiet", "--wait", "--collect", "--service-type=exec",
           "--pty" if terminal else "--pipe", "--unit=" + unit, "--property=KillMode=control-group",
           "--property=TimeoutStopSec=3s", "--working-directory=" + spec["guestCwd"]]
    # systemd-run addresses the real user manager. The vendor process uses the
    # account's login bus, Secret Service, and native configuration directories.
    for name in ("HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TERM", "COLORTERM", "XDG_RUNTIME_DIR",
                 "DBUS_SESSION_BUS_ADDRESS", "GNOME_KEYRING_CONTROL", "XDG_CONFIG_HOME", "XDG_STATE_HOME",
                 "XDG_DATA_HOME", "XDG_CACHE_HOME"):
        if name in os.environ:
            cmd.append("--setenv=" + name + "=" + os.environ[name])
    proc = subprocess.Popen(cmd + ["--", spec["program"]] + argv, env=env,
                            stdin=None if terminal else subprocess.PIPE)
    try:
        if terminal:
            return proc.wait()
        # An SSH disconnect means EOF even if the native CLI ignores stdin or
        # has forked helpers. KillMode=control-group also catches detached children.
        with selectors.DefaultSelector() as poll:
            poll.register(sys.stdin, selectors.EVENT_READ)
            while proc.poll() is None:
                if not poll.select(.2):
                    continue
                data = os.read(0, 65536)
                if not data:
                    proc.stdin.close()
                    try:
                        return proc.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        break
                try:
                    proc.stdin.write(data)
                    proc.stdin.flush()
                except BrokenPipeError:
                    break
        return proc.poll() if proc.poll() is not None else 1
    finally:
        stop_units([unit], env)
        if proc.poll() is None:
            proc.terminate()


if __name__ == "__main__":
    action, raw, *args = sys.argv[1:]
    spec = json.loads(raw)
    check_identity(spec)
    manager = manager_environment()
    for name in ("XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"):
        os.environ.setdefault(name, manager[name])
    if action == "stop":
        stop_units(args, manager)
    else:
        check_workspace(spec)
        if action == "check":
            print("ready")
        elif action in ("identity", "usage"):
            # The owner endpoint selects packaged probes. Inspect the same admitted
            # provider CLI, user and login bus as a normal chat.
            kind, source, *helpers = args
            os.chdir(spec["guestCwd"])
            # Preserve the provider's login bus. "manager" addresses systemd and
            # can differ from the Secret Service bus exported to normal Agent units.
            os.execv(sys.executable, [sys.executable, "-I", "-c", source, kind, spec["program"], *helpers])
        elif action in ("stdio", "terminal"):
            def disconnected(_signal, _frame):
                raise SystemExit(129)
            for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
                signal.signal(sig, disconnected)
            sys.exit(execute(action, spec, args[0], args[1:], manager))
        else:
            reject("invalid account operation")
