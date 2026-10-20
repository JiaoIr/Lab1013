import { config as loadEnv } from "dotenv";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";

// Load the project-root .env regardless of the current working directory.
loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

const apiKey = process.env.api_key?.trim() ?? "";
const model = process.env.model?.trim() ?? "";
const baseURL = process.env.base_url?.trim() ?? "";

if (!apiKey || !model || !baseURL) {
  throw new Error("Fill in api_key, model, and base_url in .env.");
}

const requirementsPath = fileURLToPath(new URL("./tests.txt", import.meta.url));
const generatedDirectory = fileURLToPath(new URL("./generated", import.meta.url));
const generatedTestPath = fileURLToPath(
  new URL("./generated/tests.test.ts", import.meta.url),
);

const INTERFACE_SUMMARY = `The bug-report website's submission rules are implemented in src/demo2/server.ts, which exports one pure function:

    import { validate_submission } from "../server.js";

    validate_submission(report: string): "valid" | "invalid" | "failure"

Call the function directly in a test; you do not start a server, make HTTP requests, or render HTML. It classifies exactly one bug-report submission:
- "failure": the report text contains the keyword "grass" (case-insensitive).
- "invalid": the report is empty or consists only of whitespace.
- "valid": every other report.

The user's requirements are phrased in terms of messages; map them to the returned result: a confirmation message means "valid", an error message means "failure", and a validation message means "invalid".`;

const SYSTEM_PROMPT = `You write one executable Vitest test file for the bug-report website. The interface summary at the end is a technical reference only: it tells you which function to call and how it classifies a submission. It is not a list of behaviors to test.

Rules:
- Generate only the tests the user asks for. Emit exactly one it(...) test per numbered requirement in the user's list, in the same order, and nothing else.
- Do not add any test, assertion, or scenario the user did not request.
- Keep the file minimal: import the function, then one focused test per requirement. Do not start a server, do not make HTTP requests, and avoid elaborate helpers.
- Each test must make a meaningful assertion about the function's returned value for that single requirement.
- Keep the suite deterministic. Do not depend on external networks, DNS, or the current time.
- Output exactly one TypeScript file inside a single TypeScript code block, with no prose or explanation. Use Vitest and call the function directly:
    import { describe, it, expect } from "vitest";
    import { validate_submission } from "../server.js";

The interface summary is:

${INTERFACE_SUMMARY}`;

// Extracts the model's test file from a response, unwrapping code fences when present.
function extractTestSource(output: string): string {
  const blocks = [...output.matchAll(/```(?:ts|tsx|typescript|js|javascript)?\s*\n([\s\S]*?)```/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((block) => block.length > 0);
  if (blocks.length > 0) {
    return blocks.reduce((longest, block) =>
      block.length > longest.length ? block : longest,
    );
  }
  return output.trim();
}

async function main(): Promise<void> {
  const requirements = (await readFile(requirementsPath, "utf8")).trim();
  if (requirements === "") {
    throw new Error(
      `Add the test requirements to ${requirementsPath} before generating tests.`,
    );
  }

  const client = new OpenAI({ apiKey, baseURL });
  console.log(`Generating tests with model: ${model}`);

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Test requirements:\n\n${requirements}` },
    ],
  });

  const source = extractTestSource(completion.choices[0]?.message?.content ?? "");
  if (source === "") {
    throw new Error("The model did not return any test source.");
  }

  // Re-running replaces the previous suite: clear the directory, then write.
  await rm(generatedDirectory, { recursive: true, force: true });
  await mkdir(generatedDirectory, { recursive: true });
  await writeFile(generatedTestPath, `${source}\n`, "utf8");

  console.log(`Wrote ${generatedTestPath}`);
  console.log("Run the tests with: npx tsx src/demo2/run_tests.ts");
}

main().catch((error: unknown) => {
  console.error("Test generation failed:", error);
  process.exitCode = 1;
});
