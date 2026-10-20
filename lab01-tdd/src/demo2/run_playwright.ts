import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const playwrightConfig = fileURLToPath(
  new URL("./playwright.config.ts", import.meta.url),
);
const reportPath = fileURLToPath(
  new URL("./playwright/report.json", import.meta.url),
);
const playwrightCli = require.resolve("@playwright/test/cli");

interface PlaywrightResult {
  readonly status?: string;
  readonly error?: { readonly message?: string };
}

interface PlaywrightSpec {
  readonly title?: string;
  readonly ok?: boolean;
  readonly tests?: ReadonlyArray<{
    readonly results?: ReadonlyArray<PlaywrightResult>;
  }>;
}

interface PlaywrightSuite {
  readonly title?: string;
  readonly specs?: readonly PlaywrightSpec[];
  readonly suites?: readonly PlaywrightSuite[];
}

interface PlaywrightReport {
  readonly stats?: {
    readonly expected?: number;
    readonly unexpected?: number;
    readonly flaky?: number;
    readonly skipped?: number;
    readonly duration?: number;
  };
  readonly suites?: readonly PlaywrightSuite[];
}

interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

function runPlaywright(): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(
      process.execPath,
      [playwrightCli, "test", "--config", playwrightConfig],
      { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({
        exitCode,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
  });
}

// Walks the report suites and collects the names and first error line of every
// failing test.
function collectFailures(
  suites: readonly PlaywrightSuite[] | undefined,
): string[] {
  const failures: string[] = [];

  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      if (spec.ok === false) {
        const failedResult = spec.tests?.[0]?.results?.find(
          (result) => result.status === "failed",
        );
        const message = failedResult?.error?.message?.split("\n")[0]?.trim();
        failures.push(
          `${spec.title ?? "unnamed test"}${message ? ` -- ${message}` : ""}`,
        );
      }
    }
    failures.push(...collectFailures(suite.suites));
  }

  return failures;
}

async function readReport(): Promise<PlaywrightReport | undefined> {
  try {
    return JSON.parse(await readFile(reportPath, "utf8")) as PlaywrightReport;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  console.log("Running Playwright tests ...");

  const result = await runPlaywright();
  const visibleOutput = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n");
  if (visibleOutput) console.log(visibleOutput);

  const report = await readReport();
  if (!report?.stats) {
    console.error("Playwright did not produce a machine-readable report.");
    console.error(`Exit code: ${result.exitCode ?? "unknown"}.`);
    process.exitCode = result.exitCode === 0 ? 1 : (result.exitCode ?? 1);
    return;
  }

  const passed = report.stats.expected ?? 0;
  const failed = report.stats.unexpected ?? 0;
  const flaky = report.stats.flaky ?? 0;
  const skipped = report.stats.skipped ?? 0;
  const total = passed + failed + flaky + skipped;

  console.log("");
  console.log(
    `Results: ${passed}/${total} passed, ${failed} failed` +
      `${flaky ? `, ${flaky} flaky` : ""}${skipped ? `, ${skipped} skipped` : ""}` +
      ` (${Math.round(report.stats.duration ?? result.durationMs)} ms).`,
  );
  for (const failure of collectFailures(report.suites)) {
    console.log(`  FAIL ${failure}`);
  }

  process.exitCode = failed === 0 && flaky === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error("Playwright run failed:", error);
  process.exitCode = 1;
});
