import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { filteredEnvironment } from "../testing/process.js";
import { startApiServer, type RunningServer } from "./api-server.js";

export interface ApiWorkerRequest {
  type: "request";
  id: number;
  url: string;
  method: string;
  headers: [string, string][];
  body: string;
}
export type ApiWorkerMessage =
  | { type: "ready" }
  | { type: "failure"; error: string }
  | { type: "request-error"; id: number; error: string }
  | { type: "response"; id: number; status: number; headers: [string, string][]; body: string };

export interface ApiWorkerDiagnostics {
  pid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  errors: readonly string[];
  stdout: string;
  stderr: string;
}
export interface SupervisedApiServer extends RunningServer {
  diagnostics(): ApiWorkerDiagnostics;
}

const require = createRequire(import.meta.url);
const unavailable = (): Response => Response.json({ error: "The generated API handler failed." }, { status: 500 });

/** A stable HTTP endpoint survives generated-code crashes; state is never silently restarted. */
export async function startGeneratedApiServer(options: {
  implementationPath: string;
  signal?: AbortSignal;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
}): Promise<SupervisedApiServer> {
  options.signal?.throwIfAborted();
  const child = fork(fileURLToPath(new URL("./api-worker.ts", import.meta.url)), [resolve(options.implementationPath)], {
    cwd: dirname(resolve(options.implementationPath)), execArgv: ["--import", pathToFileURL(require.resolve("tsx")).href],
    env: filteredEnvironment(), stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let closing = false;
  let failed = false;
  let sequence = 0;
  let stdout = "";
  let stderr = "";
  let capturedBytes = 0;
  const errors: string[] = [];
  const pending = new Map<number, { finish(response: Response): void; timer: NodeJS.Timeout }>();
  let readyResolve!: () => void;
  const ready = new Promise<void>(resolveReady => { readyResolve = resolveReady; });
  let closedResolve!: () => void;
  const closed = new Promise<void>(resolveClosed => { closedResolve = resolveClosed; });
  const recordError = (error: string): void => { if (errors.length < 20) errors.push(error.slice(0, 4000)); };
  const settle = (id: number, response: Response): void => {
    const request = pending.get(id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(id); request.finish(response);
  };
  let escalation: NodeJS.Timeout | undefined;
  const terminate = (): void => {
    if (child.exitCode !== null || child.signalCode !== null || escalation) return;
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), 1000);
  };
  const fail = (error: string): void => {
    recordError(error); failed = true; readyResolve();
    for (const id of pending.keys()) settle(id, unavailable());
    terminate();
  };
  const capture = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    capturedBytes += chunk.length;
    if (capturedBytes > 1_000_000) { if (!failed) fail("Generated API worker exceeded its output limit."); return; }
    if (stream === "stdout") stdout += chunk.toString();
    else stderr += chunk.toString();
  };
  child.stdout!.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr!.on("data", (chunk: Buffer) => capture("stderr", chunk));
  child.on("message", (message: ApiWorkerMessage) => {
    if (message.type === "ready") readyResolve();
    else if (message.type === "failure") fail(message.error);
    else if (message.type === "request-error") {
      recordError(message.error); settle(message.id, unavailable());
    } else if (message.type === "response") {
      try {
        const body = [204, 205, 304].includes(message.status) ? null : Buffer.from(message.body, "base64");
        settle(message.id, new Response(body, { status: message.status, headers: message.headers }));
      } catch (error) { fail(`Invalid handler response: ${String(error)}`); }
    }
  });
  child.on("error", error => fail(`API worker process error: ${error.message}`));
  child.on("close", (code, signal) => {
    if (escalation) clearTimeout(escalation);
    if (!closing && !failed) fail(`Generated API worker exited unexpectedly (code ${code}, signal ${signal}).`);
    readyResolve(); closedResolve();
  });
  const abort = (): void => fail("API execution cancelled.");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const startupTimer = setTimeout(() => fail("Generated API worker startup timed out."), options.startupTimeoutMs ?? 30_000);
  let server: RunningServer | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => closePromise ??= (async () => {
    closing = true;
    clearTimeout(startupTimer);
    options.signal?.removeEventListener("abort", abort);
    for (const id of pending.keys()) settle(id, unavailable());
    terminate();
    await Promise.all([closed, server?.close()]);
  })();
  try {
    await ready;
    clearTimeout(startupTimer);
    options.signal?.throwIfAborted();
    server = await startApiServer({ handler: async request => {
      if (failed || closing || !child.connected) return unavailable();
      const body = Buffer.from(await request.arrayBuffer()).toString("base64");
      if (failed || closing || !child.connected) return unavailable();
      const id = ++sequence;
      return new Promise<Response>(finish => {
        const timer = setTimeout(() => fail(`Generated API handler request timed out after ${options.requestTimeoutMs ?? 3000} ms.`), options.requestTimeoutMs ?? 3000);
        pending.set(id, { finish, timer });
        child.send({ type: "request", id, url: request.url, method: request.method,
          headers: [...request.headers.entries()], body } satisfies ApiWorkerRequest,
        error => { if (error && !closing) fail(`API worker IPC failed: ${error.message}`); });
      });
    } });
    return {
      url: server.url, close,
      diagnostics: () => ({ pid: child.pid ?? null, exitCode: child.exitCode, signal: child.signalCode,
        errors: [...errors], stdout, stderr }),
    };
  } catch (error) { await close(); throw error; }
}
