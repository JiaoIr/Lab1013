import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runApiValidation } from "../validation/run-validation.js";
import type { ValidationResult } from "../validation/result.js";

async function main(): Promise<void> {
  const [runPath, ...extra] = process.argv.slice(2);
  if (!runPath || extra.length) {
    throw new Error("Usage: npm run replay:api -- runs/<api-run-id>");
  }
  const runRoot = resolve(runPath);
  const historical = JSON.parse(await readFile(join(runRoot, "result.json"), "utf8")) as {
    directValidation: ValidationResult;
  };
  const implementationPath = join(runRoot, "raw", "direct-implementation.ts");
  await readFile(implementationPath, "utf8");
  await mkdir(join(runRoot, "replays"), { recursive: true });
  const outputDirectory = await mkdtemp(join(runRoot, "replays", "direct-"));
  console.log(`Implementation: ${implementationPath}`);
  const result = await runApiValidation({
    implementationPath,
    reportPath: join(outputDirectory, "vitest-report.json"),
    rawOutputPath: join(outputDirectory, "vitest-output.txt"),
  });
  const sameChecks = result.checks.length === historical.directValidation.checks.length &&
    result.checks.every(check => historical.directValidation.checks.some(previous =>
      previous.category === check.category && previous.name === check.name && previous.passed === check.passed));
  await writeFile(join(outputDirectory, "result.json"), JSON.stringify({
    implementationPath, validation: result, matchesHistoricalChecks: sameChecks,
  }, null, 2) + "\n");
  console.log(`Teacher validation: ${result.passed}/${result.total} passed`);
  for (const category of result.categories) console.log(`  ${category.name}: ${category.passed}/${category.total}`);
  for (const check of result.checks.filter(check => !check.passed)) console.log(`FAIL [${check.category}] ${check.name}`);
  console.log(`Matches historical checks: ${sameChecks}`);
  console.log(`Reports: ${outputDirectory}`);
  if (result.executionErrors?.length) {
    throw new Error(result.executionErrors.join("\n"));
  }
  // Expected assertion failures are the subject of replay, not a runner error.
  if (!sameChecks) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
