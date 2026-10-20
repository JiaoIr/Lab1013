/** Runs generated code without importing the model SDK or provider configuration. */
import { loadRegistrationHandler } from "./api-server.js";
import type { ApiWorkerMessage, ApiWorkerRequest } from "./supervised-api.js";

function send(message: ApiWorkerMessage): void {
  if (process.connected) process.send?.(message);
}
function describe(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)).slice(0, 4000);
}
function fatal(error: unknown): void {
  const message: ApiWorkerMessage = { type: "failure", error: describe(error) };
  if (process.connected) process.send?.(message, () => process.exit(1));
  else process.exit(1);
}
process.on("unhandledRejection", fatal);
process.on("uncaughtException", fatal);
process.on("disconnect", () => process.exit(0));

try {
  const handler = await loadRegistrationHandler(process.argv[2]!);
  process.on("message", (message: ApiWorkerRequest) => {
    if (message.type !== "request") return;
    void (async () => {
      try {
        const request = new Request(message.url, {
          method: message.method, headers: message.headers,
          body: Buffer.from(message.body, "base64"),
        });
        const response = await handler(request);
        if (!(response instanceof Response)) throw new Error("The generated handler must return a Response.");
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > 1_000_000) throw new Error("The generated response exceeds 1 MB.");
        send({ type: "response", id: message.id, status: response.status,
          headers: [...response.headers.entries()], body: body.toString("base64") });
      } catch (error) {
        send({ type: "request-error", id: message.id, error: describe(error) });
      }
    })();
  });
  send({ type: "ready" });
} catch (error) { fatal(error); }
