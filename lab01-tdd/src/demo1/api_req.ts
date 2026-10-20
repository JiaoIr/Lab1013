import "dotenv/config";
import OpenAI from "openai";

const apiKey = process.env.api_key?.trim() ?? "";
const model = process.env.model?.trim() ?? "";
const baseURL = process.env.base_url?.trim() ?? "";

if (!apiKey || !model || !baseURL) {
  throw new Error("Fill in api_key, model, and base_url in .env.");
}

// Students: write a prompt between the quotes.
const input: string = `bro`;

if (!input.trim()) {
  throw new Error("Fill in the input prompt in api_req.ts.");
}

const client = new OpenAI({ apiKey, baseURL });

async function main(): Promise<void> {
  const completion = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: input }],
  });

  console.log(completion.choices[0]?.message.content);
}

main().catch((error: unknown) => {
  console.error("LLM API request failed:", error);
  process.exitCode = 1;
});