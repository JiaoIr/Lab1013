import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startGeneratedApiServer, type SupervisedApiServer } from "../../src/harness/supervised-api.js";
import { runApiTrainTests } from "../../src/testing/run-generated-tests.js";
import { runApiValidation } from "../../src/validation/run-validation.js";

const directories: string[] = [];
const servers: SupervisedApiServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});
async function source(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "course-isolated-api-"));
  directories.push(directory);
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  const path = join(directory, "register.ts");
  await writeFile(path, content);
  return path;
}
async function server(content: string, options: { requestTimeoutMs?: number; startupTimeoutMs?: number; signal?: AbortSignal } = {}) {
  const result = await startGeneratedApiServer({ implementationPath: await source(content), ...options });
  servers.push(result);
  return result;
}
function post(server: SupervisedApiServer, body = "{}") {
  return fetch(`${server.url}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body });
}
const missingAwait = `export default function handler(request: Request): Response {
  const body: unknown = request.json();
  return Response.json({ error: "Missing fields" }, { status: 400 });
}`;

describe("generated API isolation", () => {
  it("preserves module state within a stage, isolates stages, and omits provider environment", async () => {
    vi.stubEnv("COURSE_FAKE_API_KEY", "must-not-enter-generated-code");
    const implementationPath = await source(`let count = 0; export default async function handler(request: Request) {
      const body = await request.json();
      return Response.json({ count: ++count, body, secretPresent: Boolean(process.env.COURSE_FAKE_API_KEY) });
    }`);
    const first = await startGeneratedApiServer({ implementationPath });
    const second = await startGeneratedApiServer({ implementationPath });
    servers.push(first, second);
    expect(await (await post(first, '{"username":"one"}')).json()).toEqual({ count: 1, body: { username: "one" }, secretPresent: false });
    expect(await (await post(first)).json()).toMatchObject({ count: 2 });
    expect(await (await post(second)).json()).toMatchObject({ count: 1 });
    expect(first.url).not.toBe(second.url);
    expect(first.diagnostics().errors).toEqual([]);
    await first.close();
    expect(() => process.kill(first.diagnostics().pid!, 0)).toThrow();
  });

  it("contains the exact missing-await rejection and keeps the HTTP endpoint alive", async () => {
    const isolated = await server(missingAwait);
    expect((await post(isolated, "{not-json")).status).toBe(400);
    await vi.waitFor(() => expect(isolated.diagnostics().errors.join(" ")).toContain("SyntaxError"));
    expect((await post(isolated)).status).toBe(500);
    expect((await fetch(`${isolated.url}/missing`)).status).toBe(404);
  });

  it.each([
    ["synchronous throw", 'export default () => { throw new Error("handler boom"); };', "handler boom"],
    ["explicit process exit", 'export default () => process.exit(7);', "exited unexpectedly"],
    ["broken import", 'throw new Error("import boom"); export default () => new Response();', "import boom"],
    ["invalid TypeScript", 'export default function { broken syntax;', "TransformError"],
  ])("contains %s and returns a bounded failure", async (_label, implementation, error) => {
    const isolated = await server(implementation);
    expect((await post(isolated)).status).toBe(500);
    await vi.waitFor(() => expect(isolated.diagnostics().errors.join(" ")).toContain(error));
  });

  it("terminates a CPU-bound handler after its request deadline", async () => {
    const isolated = await server('export default () => { while (true) {} };', { requestTimeoutMs: 100 });
    expect((await post(isolated)).status).toBe(500);
    expect(isolated.diagnostics().errors.join(" ")).toContain("request timed out");
    expect((await post(isolated)).status).toBe(500);
    await isolated.close();
    expect(() => process.kill(isolated.diagnostics().pid!, 0)).toThrow();
  });

  it("bounds generated console output", async () => {
    const isolated = await server('process.stdout.write("x".repeat(1_100_000)); export default () => new Response("ok");');
    await vi.waitFor(() => expect(isolated.diagnostics().errors.join(" ")).toContain("output limit"));
    expect((await post(isolated)).status).toBe(500);
    expect(isolated.diagnostics().stdout.length).toBeLessThanOrEqual(1_000_000);
  });

  it("bounds a hung import", async () => {
    const isolated = await server('while (true) {} export default () => new Response();', { startupTimeoutMs: 300 });
    expect((await post(isolated)).status).toBe(500);
    expect(isolated.diagnostics().errors.join(" ")).toContain("startup timed out");
  });

  it("cancels a busy worker and closes it without waiting for its deadline", async () => {
    const controller = new AbortController();
    const isolated = await server('export default () => { while (true) {} };', { requestTimeoutMs: 10_000, signal: controller.signal });
    const pending = post(isolated);
    controller.abort();
    expect((await pending).status).toBe(500);
    await isolated.close();
    expect(() => process.kill(isolated.diagnostics().pid!, 0)).toThrow();
    await expect(startGeneratedApiServer({ implementationPath: "/unused", signal: controller.signal })).rejects.toThrow();
  });
});

it("finishes all hidden validation checks when the generated handler crashes", async () => {
  const implementationPath = await source(missingAwait);
  const directory = directories.at(-1)!;
  const result = await runApiValidation({ implementationPath, reportPath: join(directory, "validation.json"), rawOutputPath: join(directory, "validation.txt") });
  expect(result.total).toBe(55);
  expect(result.executionErrors?.join(" ")).toContain("SyntaxError");
  const diagnostics = JSON.parse(await readFile(join(directory, "validation.txt.api-worker.json"), "utf8"));
  expect(diagnostics.errors.join(" ")).toContain("SyntaxError");
}, 90_000);

it("feeds a contained handler crash back as Red even if its last HTTP assertion passed", async () => {
  // Keep the train file beneath the repository so Vitest resolves its public import.
  const directory = await mkdtemp(join(process.cwd(), ".course-isolated-train-"));
  directories.push(directory);
  const implementationPath = await source(missingAwait);
  const testPath = join(directory, "register.test.ts");
  await writeFile(testPath, `import { expect, test } from "vitest";
    test("rejects malformed input", async () => {
      const response = await fetch(process.env.COURSE_API_BASE_URL + "/api/register", { method: "POST", body: "{bad-json" });
      expect(response.status).toBe(400);
    });`);
  const result = await runApiTrainTests({ implementationPath, testPath, reportPath: join(directory, "train.json"), rawOutputPath: join(directory, "train.txt") });
  expect(result.status).toBe("RED");
  expect(result.failures?.some(failure => failure.name === "Generated API handler execution")).toBe(true);
  expect(result.output).toContain("SyntaxError");
});

it("completes Direct-to-final repair after a generated handler crashes during Direct validation", async () => {
  const { runCourseScenario } = await import("../../src/run/orchestrator.js");
  const directory = await mkdtemp(join(process.cwd(), ".course-test-isolated-flow-"));
  directories.push(directory);
  const correct = await readFile("tests/validation/fixtures/api-good.ts", "utf8");
  const train = `import { test, expect } from "vitest";
    test("registers an account", async () => {
      const response = await fetch(process.env.COURSE_API_BASE_URL + "/api/register", {
        method: "POST", body: JSON.stringify({ username: "Student_1", email: "student@example.com", password: "Password01", confirmPassword: "Password01" })
      });
      expect(response.status).toBe(201);
    });
    test("rejects malformed JSON", async () => {
      const response = await fetch(process.env.COURSE_API_BASE_URL + "/api/register", { method: "POST", body: "{bad" });
      expect(response.status).toBe(400);
    });`;
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, requestUsage: [] };
  const generated = (content: string) => ({ content, rawOutput: content, usage, rawResponses: [] });
  let compared = false;
  const result = await runCourseScenario({ scenario: "api", publicBrief: "Register accounts.", implementationContract: "Export a Request handler.", testContract: "Test through HTTP.",
    modelName: "offline-isolation-regression", envFile: "offline", rehearsal: true,
    runsRoot: join(directory, "runs"), workspaceRoot: join(directory, "workspace"),
    presenter: {
      start() {}, act() {}, task() {}, artifact() {}, trainResult() {}, repairStarted() {}, repair() {}, repairRound() {}, prompt() {}, validation() {}, finish() {}, failure() {},
      stage: (_message, action) => action(), checkpoint: async () => {}, comparison: () => { compared = true; },
    },
    services: {
      generateDirect: async input => { await writeFile(input.artifactPath, missingAwait); return generated(missingAwait); },
      generateTests: async input => { await writeFile(input.artifactPath, train); return generated(train); },
      repairTests: async () => { throw new Error("The fixed suite must pass its reference."); },
      runReferenceTrainTests: (testPath, workspace, signal) => runApiTrainTests({ implementationPath: "tests/validation/fixtures/api-good.ts", testPath,
        reportPath: join(workspace.testOutputDirectory, "reference.json"), rawOutputPath: join(workspace.testOutputDirectory, "reference.txt"), ...(signal ? { signal } : {}) }),
      runTrainTests: (implementationPath, testPath, workspace, signal) => runApiTrainTests({ implementationPath, testPath,
        reportPath: join(workspace.testOutputDirectory, "train.json"), rawOutputPath: join(workspace.testOutputDirectory, "train.txt"), ...(signal ? { signal } : {}) }),
      repairImplementation: async input => {
        await writeFile(input.implementationPath, correct);
        const finalTestResult = await input.runTrainTests();
        return { status: finalTestResult.status, repairs: 1, finalTestResult, usage, rawResponses: [] };
      },
      validate: (implementationPath, arm, workspace, signal) => runApiValidation({ implementationPath,
        reportPath: join(workspace.testOutputDirectory, `${arm}.json`), rawOutputPath: join(workspace.testOutputDirectory, `${arm}.txt`), ...(signal ? { signal } : {}) }),
    },
  });
  expect(compared).toBe(true);
  expect(result.outcome).toBe("GREEN");
  expect(result.directValidation.executionErrors?.join(" ")).toContain("SyntaxError");
  expect(result.initialTrainResult?.status).toBe("RED");
  expect(result.tddValidation).toMatchObject({ passed: 55, total: 55 });
  expect(result.tddValidation?.executionErrors).toBeUndefined();
  expect(JSON.parse(await readFile(join(result.runRoot, "result.json"), "utf8")).outcome).toBe("GREEN");
}, 60_000);
