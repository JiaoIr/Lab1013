import "dotenv/config";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const apiKey = process.env.api_key;
const modelFromEnv = process.env.model;
const baseURL = process.env.base_url;

// Students: enter the path to your MCP server script. This script serves as both the application and the client.
const serverPath = ``;

if (!apiKey || !modelFromEnv || !baseURL) {
  throw new Error("Set api_key, model, and base_url in your .env file.");
}

if (!serverPath) {
  throw new Error("Enter the MCP server script path in serverPath.");
}

const model: string = modelFromEnv;
const openai = new OpenAI({ apiKey, baseURL });

async function main() {
  const mcpClient = new Client({
    name: "bug-categorizer",
    version: "1.0.0",
  });

  // The MCP client starts the server as a child process.
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", serverPath],
  });

  try {
    await mcpClient.connect(transport);

    // Discover the tools provided by the server.
    const { tools } = await mcpClient.listTools();

    console.log("Discovered MCP tools:");
    for (const tool of tools) {
      console.log(`- ${tool.name}: ${tool.description ?? ""}`);
    }

    // Convert MCP tool definitions to the format expected by the OpenAI API.
    const llmTools: OpenAI.Chat.Completions.ChatCompletionTool[] =
      tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.inputSchema as Record<string, unknown>,
        },
      }));

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content:
          'Use the bug severity manual by calling the relevant tool before categorizing the bug. Return a JSON object with exactly two fields: "severity" (low, medium, or high) and "reason".',
      },
      {
        role: "user",
        content:
          "A user reports that clicking Save closes the form, but their changes disappear when they reopen it. Categorize this bug using the manual.",
      },
    ];

    // Ask the model. If it requests tools, run them and send the results back.
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
        const output = message.content ?? "";
        console.log("\nLLM response:");
        console.log(output);

        try {
          JSON.parse(output);
          console.log("[This response is JSON]");
        } catch {
          console.log("[This response is NOT JSON]");
        }

        return;
      }

      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== "function") continue;

        console.log(`\nCalling MCP tool: ${toolCall.function.name}`);

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

main().catch((error) => {
  console.error("Request failed:", error);
  process.exitCode = 1;
});