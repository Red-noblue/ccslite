#!/usr/bin/env python3
# 为隔离 Codex 测试分配真实虚拟终端，转发输入输出，并将退出信号传给自建子进程组。
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

pid, terminal = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))


def forward_signal(number, _frame):
    try:
        os.killpg(pid, number)
    except ProcessLookupError:
        pass


signal.signal(signal.SIGTERM, forward_signal)
signal.signal(signal.SIGINT, forward_signal)
inputs = [terminal, sys.stdin.fileno()]
try:
    while True:
        ready, _, _ = select.select(inputs, [], [])
        if terminal in ready:
            try:
                data = os.read(terminal, 65536)
            except OSError:
                break
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if data:
                os.write(terminal, data)
            else:
                inputs.remove(sys.stdin.fileno())
finally:
    os.close(terminal)
    _, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
