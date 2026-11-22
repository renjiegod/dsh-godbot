"""Local PTY worker. Stdin carries commands, stdout carries raw terminal bytes,
and descriptor 3 carries acknowledgements. EOF from the coordinator hangs up
the terminal, including when the coordinator exits unexpectedly.
"""
import base64
import errno
import fcntl
import json
import os
import pwd
import select
import signal
import struct
import sys
import termios
import time


def send(message):
    os.write(3, (json.dumps(message, separators=(",", ":")) + "\n").encode())


def winsize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def terminate_group(group, sig):
    if group and group > 1 and group != os.getpgrp():
        try:
            os.killpg(group, sig)
        except ProcessLookupError:
            pass


def run():
    account = pwd.getpwuid(os.getuid())
    shell = account.pw_shell or "/bin/sh"
    cols, rows = map(int, sys.argv[1:3])
    child, master = os.forkpty()
    if child == 0:
        try:
            os.close(3)
            winsize(0, cols, rows)
            os.chdir(account.pw_dir)
            env = {k: v for k, v in os.environ.items()
                   if k in ("PATH", "LANG", "TZ", "TMPDIR") or k.startswith("LC_")}
            env.update(USER=account.pw_name, LOGNAME=account.pw_name,
                       SHELL=shell, HOME=account.pw_dir, TERM="xterm-256color")
            os.execve(shell, ["-" + os.path.basename(shell), "-i"], env)
        finally:
            os._exit(127)

    os.set_blocking(master, False)
    send({"ready": True})
    commands = bytearray()
    pending = b""
    pending_id = None
    running = True
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        while running:
            reads, writes, _ = select.select([0, master], [master] if pending else [], [])
            if 0 in reads:
                data = os.read(0, 65536)
                if not data:
                    break
                commands.extend(data)
                if len(commands) > 131072:
                    raise ValueError("invalid command size")
            while not pending and b"\n" in commands:
                line, _, rest = commands.partition(b"\n")
                commands = bytearray(rest)
                req = json.loads(line)
                if req["cmd"] == "close":
                    running = False
                    break
                if req["cmd"] == "resize":
                    winsize(master, req["cols"], req["rows"])
                    send({"ack": req["id"]})
                elif req["cmd"] == "write":
                    pending = base64.b64decode(req["data"], validate=True)
                    pending_id = req["id"]
                    if not pending:
                        send({"ack": pending_id})
            if master in writes and pending:
                try:
                    pending = pending[os.write(master, pending):]
                except BlockingIOError:
                    pass
                if not pending:
                    send({"ack": pending_id})
            if master in reads:
                try:
                    data = os.read(master, 32768)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    data = b""
                if not data:
                    _, status = os.waitpid(child, 0)
                    child = None
                    send({"exit": os.waitstatus_to_exitcode(status)})
                    break
                # A blocking pipe provides backpressure when its owner stalls.
                while data:
                    data = data[os.write(1, data):]
    finally:
        try:
            foreground = os.tcgetpgrp(master)
        except OSError:
            foreground = None
        os.close(master)
        if child:
            terminate_group(foreground, signal.SIGHUP)
            terminate_group(child, signal.SIGHUP)
            time.sleep(0.12)
            # A foreground job can catch or ignore SIGHUP.
            terminate_group(foreground, signal.SIGKILL)
            terminate_group(child, signal.SIGKILL)
            try:
                os.waitpid(child, 0)
            except ChildProcessError:
                pass


if __name__ == "__main__":
    run()
