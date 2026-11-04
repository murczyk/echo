"""Entry point the runner uses to execute one agent-written script.

    python3 -I -B -X utf8 echomap/run.py WORK_DIR

WORK_DIR holds inputs.json and script.py; result.json is written there. The
runner already isolates the process (user, network, mount and PID namespaces,
empty /tmp, /run and /proc, clean environment); this drops capabilities and
adds resource limits.
"""

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


def main():
    work = os.path.abspath(sys.argv[1])
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import echosandbox

    echosandbox.harden(LIMITS)
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
