"""Entry point the runner uses to execute one agent-written script.

    python3 -I -B -X utf8 echomap/run.py WORK_DIR

WORK_DIR holds inputs.json and script.py; result.json is written there. The
runner already isolates the process (user, network, mount and PID namespaces,
empty /tmp, /run and /proc, clean environment); this drops capabilities and
adds resource limits.
"""

import ctypes
import os
import resource
import sys
import traceback

LIMITS = {
    resource.RLIMIT_CPU: 20,
    resource.RLIMIT_AS: 768 * 1024 * 1024,
    resource.RLIMIT_FSIZE: 16 * 1024 * 1024,
    resource.RLIMIT_NOFILE: 64,
    resource.RLIMIT_CORE: 0,
}


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


def main():
    work = os.path.abspath(sys.argv[1])
    drop_capabilities()
    for limit, value in LIMITS.items():
        resource.setrlimit(limit, (value, value))
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    os.chdir(work)
    from echomap import state

    state.load(work)
    with open(os.path.join(work, "script.py"), encoding="utf-8") as handle:
        code = compile(handle.read(), "script.py", "exec")
    try:
        exec(code, {"__name__": "__main__"})
    except SystemExit:
        pass
    except BaseException:
        traceback.print_exc(limit=-3)
        return 1
    from echomap import recipes

    # Known report formats in the sources, so the runner can check the
    # published record count against them.
    state.result()["detected"] = recipes.detect()
    state.write(work)
    return 0


if __name__ == "__main__":
    sys.exit(main())
