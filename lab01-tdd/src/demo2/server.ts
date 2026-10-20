import "dotenv/config";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";

import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const PORT = Number(process.env.PORT ?? 3000);

// The website submits bug reports through the same MCP + LLM flow as demo1/tool_req.ts.
const MANUAL_SERVER_PATH = "src/demo1/manual_server.ts";

const apiKey = process.env.api_key;
const modelFromEnv = process.env.model;
const baseURL = process.env.base_url;

if (!apiKey || !modelFromEnv || !baseURL) {
  throw new Error("Set api_key, model, and base_url in your .env file.");
}

const model: string = modelFromEnv;
const openai = new OpenAI({ apiKey, baseURL });

const SYSTEM_PROMPT =
  "Use the bug severity manual by calling the relevant tool before categorizing the bug. " +
  'Return a JSON object with exactly two fields: "severity" (low, medium, high, or unknown) and "reason". ' +
  'If the manual is unavailable, the severity must be "unknown".';

// Categorizes one report with the same tool-calling loop as demo1/tool_req.ts
// and returns the raw model output text.
async function categorizeReport(report: string): Promise<string> {
  const mcpClient = new Client({
    name: "bug-categorizer",
    version: "1.0.0",
  });

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", MANUAL_SERVER_PATH],
  });

  try {
    await mcpClient.connect(transport);

    const { tools } = await mcpClient.listTools();

    const llmTools: OpenAI.Chat.Completions.ChatCompletionTool[] = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }));

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: report },
    ];

    for (let step = 0; step < 5; step++) {
      const response = await openai.chat.completions.create({
        model,
        messages,
        tools: llmTools,
        tool_choice: "auto",
        response_format: { type: "json_object" },
      });

      const message = response.choices[0]?.message;
      if (!message) {
        throw new Error("The LLM returned an empty response.");
      }

      messages.push(message);

      if (!message.tool_calls?.length) {
        return message.content ?? "";
      }

      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== "function") continue;

        console.log(`Calling MCP tool: ${toolCall.function.name}`);

        const result = await mcpClient.callTool({
          name: toolCall.function.name,
          arguments: JSON.parse(toolCall.function.arguments),
        });

        const toolOutput = result.content
          .map((item) => (item.type === "text" ? item.text : ""))
          .filter(Boolean)
          .join("\n");

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolOutput,
        });
      }
    }

    throw new Error("The LLM exceeded the maximum number of tool-call steps.");
  } finally {
    await mcpClient.close();
  }
}

export type SubmissionStatus = "valid" | "invalid" | "failure";

// Classifies one bug-report submission:
// - "failure": the report text contains the keyword "grass" (case-insensitive).
// - "invalid": the report is empty or consists only of whitespace.
// - "valid": every other report.
// The empty ("invalid") case is intentionally left unimplemented: an empty
// report currently falls through to "valid" and is confirmed by /submit.
export function validate_submission(report: string): SubmissionStatus {
  const text = report.trim();

  if (text.toLowerCase().includes("grass")) {
    return "failure";
  }

  // Requirement gap kept on purpose: an empty report is not rejected yet.
  return "valid";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const CONFIRMATION_HTML = `
      <section class="message success" role="status">
        <p>Your bug report has been submitted.</p>
      </section>`;

const ERROR_HTML = `
      <section class="message error" role="alert">
        <p>Submission failed. Please try again.</p>
      </section>`;

function modelOutputHtml(output: string): string {
  let pretty = output.trim();
  try {
    pretty = JSON.stringify(JSON.parse(pretty), null, 2);
  } catch {
    // Display the raw output when the model did not return valid JSON.
  }
  return `
      <section class="output">
        <h2>Model output</h2>
        <pre>${escapeHtml(pretty)}</pre>
      </section>`;
}

// The replacer must be a function so "$" sequences in the result stay literal.
function renderPage(template: string, resultHtml: string): string {
  return template.replace("<!-- result -->", () => resultHtml);
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(html);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

export interface RunningServer {
  /** Base URL of the running site, for example `http://127.0.0.1:3000`. */
  readonly url: string;
  /** Stops the server and resolves once it has closed. */
  close(): Promise<void>;
}

export interface StartServerOptions {
  /** TCP port to listen on. Use 0 to bind a free port. Defaults to 0. */
  readonly port?: number;
}

// Builds the HTTP request handler. Reading the page and stylesheet is kept out
// of module load time so tests can import this file without a server already
// listening.
export async function createRequestListener(): Promise<RequestListener> {
  const template = await readFile(new URL("./index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");

  return async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

    try {
      if (request.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        sendHtml(response, renderPage(template, ""));
        return;
      }

      if (request.method === "GET" && pathname === "/styles.css") {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/css; charset=utf-8",
        });
        response.end(styles);
        return;
      }

      if (request.method === "POST" && pathname === "/submit") {
        const body = await readBody(request);
        const report = (new URLSearchParams(body).get("report") ?? "").trim();

        // Simulated submission failure: the backend rejects reports containing the trigger word.
        if (validate_submission(report) === "failure") {
          sendHtml(response, renderPage(template, ERROR_HTML));
          return;
        }

        // Requirement gap kept on purpose: an empty report never shows a validation message.
        if (report === "") {
          sendHtml(response, renderPage(template, CONFIRMATION_HTML));
          // replace the line above with this line
          // sendHtml(response, renderPage(template, `<section role="alert">Please enter a bug report.</section>`));
          return;
        }

        try {
          const output = await categorizeReport(report);
          sendHtml(response, renderPage(template, CONFIRMATION_HTML + modelOutputHtml(output)));
        } catch (error) {
          console.error("Categorization failed:", error);
          sendHtml(response, renderPage(template, ERROR_HTML));
        }
        return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.");
    } catch (error) {
      console.error("Request failed:", error);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      response.end("Internal server error.");
    }
  };
}

// Starts the site and resolves once it is accepting connections.
export async function startServer(
  options: StartServerOptions = {},
): Promise<RunningServer> {
  const server = createServer(await createRequestListener());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The bug report server did not receive a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function main(): Promise<void> {
  const server = await startServer({ port: PORT });

  console.log(`Bug report form: ${server.url}`);
  console.log(`Categorization model: ${model}`);
  console.log("Press Ctrl+C to stop.");

  process.on("SIGINT", () => {
    void server.close().then(() => process.exit(0));
  });
}

// Start the site only when this file is the process entry point, so tests and
// other modules can import startServer() without a server already listening.
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error("Startup failed:", error);
    process.exitCode = 1;
  });
}
