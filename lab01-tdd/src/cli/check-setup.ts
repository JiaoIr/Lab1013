/** Offline setup check for the student demo commands. All model responses come from localhost. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { CourseScenario } from "../agents/generate.js";
import type { ScenarioRunResult } from "../run/orchestrator.js";
import { filteredEnvironment } from "../testing/process.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const invalidGuiTest = `
test("smoke reference disagreement", async ({ page }) => {
  await page.goto(process.env.COURSE_GUI_BASE_URL!);
  expect(await page.title()).toBe("Deliberately wrong smoke title");
});
`;
interface SmokeCase {
  readonly name: string;
  readonly scenario: CourseScenario;
  readonly fallback: boolean;
}
interface ProviderRequest {
  readonly model: string;
  readonly stream?: boolean;
  readonly tools: readonly {
    readonly function: {
      readonly name: string;
      readonly description: string;
      readonly parameters: { readonly properties: Record<string, { readonly const?: string; readonly enum?: readonly string[] }> };
    };
  }[];
}

async function checkCase(spec: SmokeCase, root: string, interactive: boolean): Promise<unknown> {
  const directory = join(root, spec.name);
  await mkdir(directory);
  // Execute the exact repository package scripts, with isolated generated artifacts.
  await writeFile(join(directory, "package.json"), await readFile(join(projectRoot, "package.json")));
  for (const name of ["src", "node_modules"]) {
    await symlink(join(projectRoot, name), join(directory, name), process.platform === "win32" ? "junction" : "dir");
  }
  const scenario = spec.scenario;
  const good = await readFile(join(projectRoot, "tests/validation/fixtures", scenario === "api" ? "api-good.ts" : "gui-good.html"), "utf8");
  // Missing await deliberately recreates the detached JSON rejection handled by the supervised API worker.
  const direct = scenario === "api"
    ? `export default function register(request: Request): Response {
  void request.json();
  return Response.json({ error: "Incomplete handler" }, { status: 400 });
}`
    : good.replace("controls.password.type = show ? 'text' : 'password';", "controls.password.type = 'password';");
  assert.notEqual(direct, good, "The smoke baseline must contain a real defect.");
  const train = spec.fallback
    ? scenario === "api"
      ? `import { expect, test } from "vitest";
test("smoke reference disagreement", async () => {
  const response = await fetch(process.env.COURSE_API_BASE_URL + "/api/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "SmokeUser", email: "smoke@example.com", password: "SmokePassword9", confirmPassword: "SmokePassword9" }),
  });
  expect(response.status).toBe(418);
});`
      : `import { expect, test } from "@playwright/test";\n${invalidGuiTest}`
    : await readFile(join(projectRoot, "tests/setup", scenario === "api" ? "api-train.test.ts" : "gui-train.spec.ts"), "utf8") + (scenario === "gui" ? invalidGuiTest : "");
  const providerErrors: string[] = [];
  const requests: string[] = [];
  const provider = createServer(async (incoming, outgoing) => {
    try {
      assert.equal(incoming.method, "POST");
      assert.equal(incoming.url, "/v1/chat/completions");
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk as Uint8Array));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderRequest;
      assert.equal(body.model, "deepseek-v4-flash");
      assert.ok(!body.stream, "The smoke provider expects non-streaming requests.");
      assert.equal(body.tools.length, 1);
      const fn = body.tools[0]!.function;
      assert.equal(fn.name, "write_file");
      const stage = "edits" in fn.parameters.properties ? "test_repair"
        : fn.description.includes("TDD working implementation") ? "implementation_repair"
          : fn.description.includes("train-test suite") ? "test_generation" : "direct";
      const target = stage === "implementation_repair"
        ? join(directory, "workspace", scenario, "tdd", scenario === "api" ? "register.ts" : "index.html")
        : fn.parameters.properties.path?.const ?? fn.parameters.properties.path?.enum?.[0];
      assert.ok(target?.startsWith(join(directory, "workspace") + sep), "Only this isolated workspace is writable.");
      const args = stage === "test_repair"
        ? { path: target, edits: [{ reason: "Deliberate rejected edit exercises the turn-limit fallback.", old_text: "smoke fragment that does not exist", new_text: "replacement" }] }
        : { path: target, content: stage === "direct" ? direct : stage === "test_generation" ? train : good };
      requests.push(stage);
      assert.ok(requests.length <= 10, "Unexpected model loop.");
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({
        id: `smoke-${requests.length}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [{ index: 0, finish_reason: "tool_calls", message: {
          role: "assistant", content: null,
          tool_calls: [{ id: `write-${requests.length}`, type: "function", function: { name: "write_file", arguments: JSON.stringify(args) } }],
        } }],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      }));
    } catch (error) {
      providerErrors.push(String(error));
      outgoing.writeHead(400, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: { message: String(error), type: "smoke_provider_error" } }));
    }
  });
  await new Promise<void>((accept, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", accept); });
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(join(directory, ".env"), `base_url=http://127.0.0.1:${address.port}/v1\napi_key=offline-smoke-only\nmodel=deepseek-v4-flash\n`, { mode: 0o600 });
  let stdout = "";
  let stderr = "";
  const previews = new Map<string, Promise<boolean>>();
  const started = performance.now();
  let exitCode: number | null;
  try {
    // Keep GUI's default preview path enabled; suppress only opening desktop tabs.
    const args = ["run", `demo:${scenario}`, "--", "--no-open", ...(scenario === "api" && !interactive ? ["--no-interactive"] : [])];
    const npmCli = process.env.npm_execpath;
    assert.ok(npmCli, "Start this check with npm run check:setup.");
    const child = spawn(process.execPath, [npmCli, ...args], {
      cwd: directory, env: filteredEnvironment(), stdio: [interactive ? "inherit" : "ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (interactive) process.stdout.write(chunk);
      for (const match of stdout.matchAll(/(?:Standard|Direct|TDD) preview: (http:\/\/localhost:\d+)/g)) {
        const url = match[1]!;
        if (!previews.has(url)) previews.set(url, fetch(url).then(async response => response.ok && (await response.text()).includes("<html"), () => false));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (interactive) process.stderr.write(chunk);
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, interactive ? 30 * 60_000 : 180_000);
    try {
      exitCode = await new Promise<number | null>((accept, reject) => { child.once("error", reject); child.once("close", accept); });
    } finally { clearTimeout(timer); clearTimeout(killTimer); }
  } finally {
    await new Promise<void>((accept, reject) => provider.close(error => error ? reject(error) : accept()));
    await writeFile(join(directory, "console.log"), `${stdout}\n${stderr}`);
    await writeFile(join(directory, "provider.json"), JSON.stringify({ simulated: true, requests, errors: providerErrors }, null, 2));
  }
  assert.deepEqual(providerErrors, [], `Local provider errors; see ${directory}/console.log`);
  assert.equal(exitCode, 0, `CLI failed; see ${directory}/console.log`);
  const runs = await readdir(join(directory, "runs"));
  assert.equal(runs.length, 1);
  const result = JSON.parse(await readFile(join(directory, "runs", runs[0]!, "result.json"), "utf8")) as ScenarioRunResult;
  assert.equal(result.outcome, spec.fallback ? "INVALID_TRAIN_SUITE" : "GREEN");
  assert.ok(stdout.includes("Run complete"), "The CLI must reach final comparison.");
  assert.equal(result.directValidation.total, scenario === "api" ? 55 : 36);
  assert.equal(result.tddValidation?.total, result.directValidation.total);
  assert.ok(!result.tddValidation?.executionErrors?.length || spec.fallback, "Repaired handler must execute cleanly.");
  if (spec.fallback) {
    const artifact = scenario === "api" ? "register.ts" : "index.html";
    assert.equal(
      await readFile(join(directory, "workspace", scenario, "direct", artifact), "utf8"),
      await readFile(join(directory, "workspace", scenario, "tdd", artifact), "utf8"),
      "Invalid tests must leave the shared implementation unchanged.",
    );
    assert.ok(result.repairSkippedReason);
    assert.equal(requests.filter(stage => stage === "implementation_repair").length, 0);
    assert.equal(requests.filter(stage => stage === "test_repair").length, scenario === "api" ? 6 : 0);
  } else {
    assert.equal(result.initialTrainResult?.status, "RED");
    assert.equal(result.finalTrainResult?.status, "GREEN");
    assert.equal(result.tddValidation!.passed, result.tddValidation!.total);
    assert.ok(result.tddValidation!.passed > result.directValidation.passed);
    assert.deepEqual(requests, ["direct", "test_generation", "implementation_repair"]);
    if (scenario === "gui") assert.equal(result.excludedTrainTestNames?.length, 1);
  }
  if (scenario === "api") assert.ok(result.directValidation.executionErrors?.length, "Detached JSON rejection must be recorded without killing the demo.");
  if (scenario === "gui") {
    assert.equal(previews.size, 3, "Standard, Direct and TDD previews must all start.");
    assert.ok((await Promise.all(previews.values())).every(Boolean), "Every preview must serve HTML.");
    for (const url of previews.keys()) {
      assert.equal(await fetch(url).then(() => true, () => false), false, "Preview must close when the demo exits.");
    }
  }
  const summary = {
    name: spec.name, scenario, command: `npm run demo:${scenario}`, exitCode,
    outcome: result.outcome, interactive, direct: `${result.directValidation.passed}/${result.directValidation.total}`,
    final: `${result.tddValidation!.passed}/${result.tddValidation!.total}`,
    simulatedRequests: requests.length, previewServersChecked: previews.size,
    durationMs: Math.round(performance.now() - started), directory,
  };
  console.log(JSON.stringify(summary));
  return summary;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let output = tmpdir();
  let retainOutput = false;
  let interactive = false;
  let selectedCase: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--interactive") interactive = true;
    else if (args[i] === "--output" && args[i + 1]) { output = resolve(args[++i]!); retainOutput = true; }
    else if (args[i] === "--case" && args[i + 1]) selectedCase = args[++i];
    else throw new Error("Usage: npm run check:setup -- [--output DIRECTORY] [--interactive] [--case CASE_NAME]");
  }
  if (interactive) assert.ok(process.stdin.isTTY, "Interactive smoke checks require a terminal.");
  const cases: readonly SmokeCase[] = [
    { name: "api-crash-repaired", scenario: "api", fallback: false },
    { name: "api-turn-limit-fallback", scenario: "api", fallback: true },
    { name: "gui-exclusion-repaired", scenario: "gui", fallback: false },
    { name: "gui-invalid-suite-fallback", scenario: "gui", fallback: true },
  ];
  if (selectedCase) assert.ok(cases.some(spec => spec.name === selectedCase), `Unknown smoke case: ${selectedCase}`);
  await mkdir(output, { recursive: true });
  // macOS aliases /var to /private/var; match the child process's canonical cwd.
  const root = await realpath(await mkdtemp(join(output, "demo-smoke-")));
  console.log(`OFFLINE DEMO CLI SMOKE — localhost responses; no paid model calls. Evidence: ${root}`);
  const results: unknown[] = [];
  let passed = false;
  try {
    for (const spec of cases.filter(spec => !selectedCase || selectedCase === spec.name)) results.push(await checkCase(spec, root, interactive));
    await writeFile(join(root, "summary.json"), JSON.stringify({ passed: true, simulatedProvider: true, paidRequests: 0, results }, null, 2));
    passed = true;
    console.log(`All ${results.length} setup checks passed. No paid model calls.${retainOutput ? ` Evidence: ${root}/summary.json` : ""}`);
  } finally {
    // Retain logs/artifacts, without leaving dependency links or a stale endpoint config.
    for (const name of await readdir(root)) {
      for (const link of ["src", "node_modules", ".env"]) await rm(join(root, name, link), { force: true, recursive: true }).catch(() => {});
    }
    if (passed && !retainOutput) await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
