import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const generatedDirectory = fileURLToPath(new URL("./generated", import.meta.url));
const generatedTestPath = fileURLToPath(
  new URL("./generated/tests.test.ts", import.meta.url),
);
const vitestConfig = fileURLToPath(new URL("./vitest.config.ts", import.meta.url));
const reportPath = join(generatedDirectory, "report.json");
const vitestCli = join(
  dirname(require.resolve("vitest/package.json")),
  "vitest.mjs",
);

interface VitestAssertion {
  readonly status?: string;
  readonly fullName?: string;
  readonly title?: string;
  readonly failureMessages?: readonly string[];
}

interface VitestReport {
  readonly success?: boolean;
  readonly numTotalTests?: number;
  readonly numPassedTests?: number;
  readonly numFailedTests?: number;
  readonly testResults?: ReadonlyArray<{
    readonly assertionResults?: readonly VitestAssertion[];
  }>;
}

interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

function runVitest(): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(
      process.execPath,
      [
        vitestCli,
        "run",
        "--config",
        vitestConfig,
        "--reporter=json",
        `--outputFile=${reportPath}`,
        "--no-color",
      ],
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

function firstLine(message: string): string {
  return message.split("\n")[0]?.trim() ?? message.trim();
}

async function readReport(): Promise<VitestReport | undefined> {
  try {
    return JSON.parse(await readFile(reportPath, "utf8")) as VitestReport;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  try {
    await readFile(generatedTestPath, "utf8");
  } catch {
    console.error(
      `No generated tests found at ${generatedTestPath}.\nRun "npx tsx src/demo2/generate_tests.ts" first.`,
    );
    process.exitCode = 1;
    return;
  }

  await mkdir(generatedDirectory, { recursive: true });
  console.log(
    `Running generated tests from ${relative(projectRoot, generatedTestPath)} ...`,
  );

  const result = await runVitest();
  const visibleOutput = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n");
  if (visibleOutput) console.log(visibleOutput);

  const report = await readReport();
  if (!report) {
    console.error("Vitest did not produce a machine-readable report.");
    console.error(`Exit code: ${result.exitCode ?? "unknown"}.`);
    process.exitCode = 1;
    return;
  }

  const total = report.numTotalTests ?? 0;
  const passed = report.numPassedTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const failures = (report.testResults ?? [])
    .flatMap((file) => file.assertionResults ?? [])
    .filter((assertion) => assertion.status === "failed");

  console.log("");
  console.log(
    `Results: ${passed}/${total} passed, ${failed} failed (${result.durationMs} ms).`,
  );
  for (const failure of failures) {
    console.log(`  FAIL ${failure.fullName ?? failure.title ?? "unnamed test"}`);
    console.log(`    ${firstLine(failure.failureMessages?.[0] ?? "no failure message")}`);
  }

  process.exitCode = failed === 0 && report.success ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error("Test run failed:", error);
  process.exitCode = 1;
});
