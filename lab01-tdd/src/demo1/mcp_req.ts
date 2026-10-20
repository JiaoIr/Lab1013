import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

async function main() {
  const client = new Client({
    name: "bug-categorizer",
    version: "1.0.0",
  });

// Students: enter the path to your MCP server script.
const serverPath = ``;

if (!serverPath) {
  throw new Error("Please enter the path to your MCP server script in serverPath.");
}

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", serverPath],
});

  try {
    await client.connect(transport);

    // Ask the server what tools it provides.
    const { tools } = await client.listTools();
    
    console.log("Tools available from the MCP server:");
    for (const tool of tools) {
      console.log(`- ${tool.name}: ${tool.description}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("MCP client failed:", error);
  process.exitCode = 1;
});