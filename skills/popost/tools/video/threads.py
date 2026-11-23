"""How many threads a reading tool may use: asked for in the environment, never more than the processors this
process is allowed (its affinity, and the CPU quota of its container), and four when nothing is asked.

Libraries that are left to decide for themselves count the machine's processors, not the ones the process may use:
in a container limited to one processor on a large host they start dozens of threads, and one of them (onnxruntime,
when its thread count is left on automatic) pins its threads to processors of its own choosing, outside the set the
process was started on. Both made a shared machine unusable. So the count is always given.
"""
import math
import os


def allowed_processors() -> int:
    try:
        n = len(os.sched_getaffinity(0))
    except AttributeError:  # not Linux
        n = os.cpu_count() or 1
    try:
        with open("/sys/fs/cgroup/cpu.max", encoding="ascii") as fh:  # cgroup v2: "<quota> <period>" or "max <period>"
            quota, period = fh.read().split()[:2]
        if quota != "max":
            n = min(n, max(1, math.ceil(int(quota) / int(period))))
    except (OSError, ValueError):
        pass
    return max(1, n)


def threads(*names: str, default: int = 4) -> int:
    """The first of the named environment variables that is set (POPOST_TOOL_THREADS is always looked at last)."""
    for name in (*names, "POPOST_TOOL_THREADS"):
        value = os.environ.get(name, "").strip()
        if value.isdigit() and int(value) > 0:
            return min(int(value), allowed_processors())
    return min(default, allowed_processors())
