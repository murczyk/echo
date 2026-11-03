"""Entry point the runner uses for one document tool call.

    python3 -I -B -X utf8 echodoc/run.py WORK_DIR

WORK_DIR holds inputs.json, sources/<n>.docx and, in script mode, script.py.
Mode "outline" renders one source with no agent-written code; mode "script"
runs script.py, whose saves land in WORK_DIR/out. result.json is written only
on success (exit 0); a failure prints a short traceback and exits 1. The
runner already isolates the process (user, network, mount and PID namespaces,
empty /tmp, /run and /proc, clean environment); this drops capabilities and
adds resource limits.
"""

import os
import resource
import sys
import traceback

LIMITS = {
    resource.RLIMIT_CPU: 45,
    resource.RLIMIT_AS: 1536 * 1024 * 1024,
    resource.RLIMIT_FSIZE: 48 * 1024 * 1024,
    resource.RLIMIT_NOFILE: 128,
    resource.RLIMIT_CORE: 0,
}


def run_outline(echodoc, state):
    request = state.inputs.get("outline") or {}
    document = echodoc.open(request.get("source"))
    state.result()["outline"] = echodoc.outline(
        document, after=request.get("after") or 0, limit=request.get("limit") or 80,
    )


def run_script(work):
    with open(os.path.join(work, "script.py"), encoding="utf-8") as handle:
        code = compile(handle.read(), "script.py", "exec")
    try:
        exec(code, {"__name__": "__main__"})
    except SystemExit:
        pass


def main():
    work = os.path.abspath(sys.argv[1])
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import echosandbox

    echosandbox.harden(LIMITS)
    os.chdir(work)
    try:
        import echodoc
        from echodoc import state

        state.load(work)
        mode = state.inputs.get("mode", "script")
        if mode == "outline":
            run_outline(echodoc, state)
        elif mode == "script":
            run_script(work)
        else:
            raise ValueError(f"unknown mode {mode!r}")
    except BaseException:
        traceback.print_exc(limit=-3)
        return 1
    state.write(work)
    return 0


if __name__ == "__main__":
    sys.exit(main())
