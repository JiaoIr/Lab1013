"""Probe existing Playwright installations without installing or compiling anything."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from utils.process import process_group_kwargs, terminate_process_tree

PROBE = r"""
const start = Date.now();
const mark = stage => console.log(JSON.stringify({stage, ms: Date.now()-start}));
(async () => {
  mark('require_start');
  const {chromium} = require(process.argv[1]);
  mark('require_done');
  if (!chromium) throw new Error('Playwright did not export chromium');
  mark('launch_start');
  const browser = await chromium.launch();
  mark('launch_done');
  await browser.close();
  mark('close_done');
})().catch(error => { console.error(error.stack || String(error)); process.exit(1); });
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workers', type=int, default=1)
    parser.add_argument('--timeout', type=float, default=60)
    parser.add_argument('--ids', type=int, nargs='+', default=list(range(1, 51)))
    args = parser.parse_args()
    if not 1 <= args.workers <= 50 or args.timeout <= 0 or any(not 1 <= i <= 50 for i in args.ids):
        parser.error('workers and ids must be 1-50; timeout must be positive')
    node = shutil.which('node')
    if not node:
        parser.error('node is not on PATH')
    out = ROOT / 'workspace/browser-checks' / (datetime.now().strftime('%Y%m%d-%H%M%S-%f') + f'-w{args.workers}')
    out.mkdir(parents=True)
    print(f'Results: {out}', flush=True)

    def check(i):
        root = ROOT / f'workspace/smoke-parallel-user-{i}'
        entry = root / 'node_modules/@playwright/test/index.js'
        stdout_path, stderr_path = out / f'{i}.stdout.log', out / f'{i}.stderr.log'
        started = time.monotonic()
        timed_out = False
        with stdout_path.open('wb') as stdout, stderr_path.open('wb') as stderr:
            process = subprocess.Popen([node, '-e', PROBE, str(entry)], cwd=root,
                                       stdout=stdout, stderr=stderr, stdin=subprocess.DEVNULL,
                                       env={**os.environ, 'DEBUG': 'pw:browser'}, **process_group_kwargs())
            try:
                process.wait(timeout=args.timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                terminate_process_tree(process)
                process.wait(timeout=10)
        elapsed = round(time.monotonic() - started, 3)
        events = []
        for line in stdout_path.read_text(encoding='utf-8', errors='replace').splitlines():
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        stderr = stderr_path.read_text(encoding='utf-8', errors='replace')
        original = json.loads((root / '.arc/implementation/report.json').read_text(encoding='utf-8-sig'))
        row = dict(index=i, passed=process.returncode == 0 and not timed_out,
                   timed_out=timed_out, exit_code=process.returncode, seconds=elapsed,
                   events=events, stderr=stderr, original_errors=original['errors'])
        (out / f'{i}.json').write_text(json.dumps(row, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f"[{i:02}] {'PASS' if row['passed'] else 'TIMEOUT' if timed_out else 'FAIL'} {elapsed}s last={events[-1]['stage'] if events else 'none'}", flush=True)
        return row

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = [future.result() for future in as_completed([pool.submit(check, i) for i in args.ids])]
    results.sort(key=lambda row: row['index'])
    summary = dict(workers=args.workers, timeout=args.timeout, requested=len(args.ids),
                   passed=sum(row['passed'] for row in results), results=results)
    (out / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"Finished: {summary['passed']}/{len(results)} passed. {out / 'summary.json'}", flush=True)


if __name__ == '__main__':
    main()
