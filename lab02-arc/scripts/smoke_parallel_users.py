"""Run up to 50 smoke compilations concurrently with a separate .envN for each process."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from datetime import datetime


ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("k", type=int, help="Number of concurrent processes (1-50)")
    parser.add_argument("--dry-run", action="store_true", help="Print commands without running")
    args = parser.parse_args()
    if not 1 <= args.k <= 50:
        parser.error("k must be between 1 and 50")

    env_files = [ROOT / f".env{i}" for i in range(1, args.k + 1)]
    missing = [str(path) for path in env_files if not path.is_file()]
    if missing and not args.dry_run:
        parser.error("Missing environment files: " + ", ".join(missing))

    commands = [
        [sys.executable, "-u", "src/main.py", "compile", "example/smoke",
         "-o", f"workspace/smoke-parallel-user-{i}", "--port", str(33000 + i)]
        for i in range(1, args.k + 1)
    ]
    for i, command in enumerate(commands, 1):
        print(f"[{i:02d}] ARC_ENV_FILE={env_files[i - 1]} {subprocess.list2cmdline(command)}", flush=True)
    if args.dry_run:
        return 0

    log_dir = ROOT / "workspace" / "smoke-parallel-user-logs" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    log_dir.mkdir(parents=True)
    print(f"Logs: {log_dir}", flush=True)
    jobs = []
    interrupted = False
    failed_to_start = False
    try:
        # Launch every process before waiting for any of them.
        for i, command in enumerate(commands, 1):
            log_path = log_dir / f"smoke-parallel-user-{i}.log"
            # Keep the parent environment unchanged; select an absolute file per child.
            child_env = os.environ.copy()
            child_env["ARC_ENV_FILE"] = str(env_files[i - 1])
            with log_path.open("wb") as log:
                process = subprocess.Popen(
                    command, cwd=ROOT, env=child_env, stdout=log, stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
                    start_new_session=os.name != "nt",
                )
            jobs.append({"index": i, "process": process, "started": time.monotonic(),
                         "command": command, "env_file": str(env_files[i - 1]), "log": str(log_path)})
        pending = list(jobs)
        while pending:
            for job in pending[:]:
                code = job["process"].poll()
                if code is not None:
                    job["exit_code"] = code
                    job["seconds"] = round(time.monotonic() - job["started"], 2)
                    print(f"[{job['index']:02d}] exit={code} elapsed={job['seconds']}s", flush=True)
                    pending.remove(job)
            if pending:
                time.sleep(0.2)
    except KeyboardInterrupt:
        interrupted = True
        print("Stopping running process trees...", flush=True)
    except OSError as exc:
        failed_to_start = True
        print(f"Cannot start process: {exc}", file=sys.stderr)
    finally:
        for job in jobs:
            process = job["process"]
            if process.poll() is None:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                else:
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            job.setdefault("exit_code", process.returncode)
            job.setdefault("seconds", round(time.monotonic() - job["started"], 2))
        results = [{key: value for key, value in job.items() if key not in {"process", "started"}}
                   for job in jobs]
        summary = {"requested": args.k, "started": len(jobs), "interrupted": interrupted,
                   "failed_to_start": failed_to_start, "results": results}
        (log_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    passed = sum(job["exit_code"] == 0 for job in jobs)
    print(f"Completed: {passed}/{args.k} succeeded. Summary: {log_dir / 'summary.json'}")
    return 130 if interrupted else int(failed_to_start or passed != args.k)


if __name__ == "__main__":
    raise SystemExit(main())
