"""Process hardening shared by the sandboxed script entry points.

The runner already isolates each script (user, network, mount and PID
namespaces, empty /tmp, /run and /proc, clean environment). `harden` then drops
every capability, sets no_new_privs and applies resource limits before any
agent-written code runs.
"""

import ctypes
import resource

PR_CAPBSET_DROP = 24
PR_SET_NO_NEW_PRIVS = 38
LINUX_CAPABILITY_VERSION_3 = 0x20080522


def drop_capabilities():
    """The script is root only inside its own user namespace, which owns the
    tmpfs mounts hiding /tmp and /proc. Without capabilities it cannot unmount
    them or regain privileges through exec."""
    libc = ctypes.CDLL(None, use_errno=True)
    for capability in range(64):
        libc.prctl(PR_CAPBSET_DROP, capability, 0, 0, 0)
    header = (ctypes.c_uint32 * 2)(LINUX_CAPABILITY_VERSION_3, 0)
    data = (ctypes.c_uint32 * 6)()
    if libc.capset(header, data) != 0:
        raise OSError(ctypes.get_errno(), "capset failed")
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "no_new_privs failed")


def harden(limits):
    """Drops capabilities, then sets each `resource.RLIMIT_*` in `limits` as
    both the soft and the hard limit."""
    drop_capabilities()
    for limit, value in limits.items():
        resource.setrlimit(limit, (value, value))
