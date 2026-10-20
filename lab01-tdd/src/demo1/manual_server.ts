import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const manual = ``;

serveStdio(() => {
  const server = new McpServer({
    name: "bug-categorization-manual",
    version: "1.0.0",
  });

  server.registerTool(
    "get_bug_categorization_manual",
    {
      description: "Retrieve the manual used to categorize bug severity.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [{ type: "text", text: manual }],
    })
  );

  return server;
});