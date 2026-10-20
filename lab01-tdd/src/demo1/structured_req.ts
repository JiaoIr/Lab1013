import "dotenv/config";
import OpenAI from "openai";

const apiKey = process.env.api_key?.trim() ?? "";
const model = process.env.model?.trim() ?? "";
const baseURL = process.env.base_url?.trim() ?? "";

if (!apiKey || !model || !baseURL) {
  throw new Error("Fill in api_key, model, and base_url in .env.");
}

// Students: write a prompt between the quotes.
const sys_input = ``;

if (!sys_input.trim()) {
  throw new Error("Fill in the system input prompt");
}

const bug_report =
  "When I click Save, the form closes, but my changes disappear when I reopen it.";

const client = new OpenAI({ apiKey, baseURL });

async function main(): Promise<void> {
  const completion = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: sys_input  },
      { role: "user", content: bug_report },
    ],
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0]?.message.content;

  if (!content) {
    throw new Error("The model returned an empty response.");
  }

  let result: unknown;

  try {
    result = JSON.parse(content);
    console.log("[This response is JSON!]");
  } catch {
    throw new Error("The model response was not valid JSON.");
  }

  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result)
  ) {
    throw new Error("The response must be a JSON object.");
  }

  const object = result as Record<string, unknown>;
  const allowedSeverities = ["low", "medium", "high", "unknown"];

  if (
    typeof object.severity !== "string" ||
    !allowedSeverities.includes(object.severity) ||
    typeof object.reason !== "string"
  ) {
    throw new Error("The JSON object does not match the expected severity fields of low, medium, high, unknown.");
  }

  console.log("Severity:", object.severity);
  console.log("Reason:", object.reason);
}

main().catch((error: unknown) => {
  console.error("LLM API request failed:", error);
  process.exitCode = 1;
});