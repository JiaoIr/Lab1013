## Setup
Refer to [demo_setup.md](demo_setup.md) for setup instructions. Ensure that you do so before beginning the demo.

# Demo 1: Calling LLMs and creating agents

## 1.1 Calling LLMs via API

### 1.1.1 Creating an API Request

Open `src/demo1/api_req.ts`. This script sends a prompt to an LLM through the OpenAI API and prints the model’s text response.

**Student task:** Replace the example prompt with a question of your own, then run the script:

```bash
npx tsx src/demo1/api_req.ts
```

You should see the response from the LLM printed in the console.

### 1.1.2 Structuring the Output

We’ll now use the context of creating a bug-categorisation agent, and use a bug report as the input for our LLM call.

In `src/demo1/api_req.ts`, replace the prompt with:
```ts
const input: string = `Report: When I click Save, the form closes, but my changes disappear when I reopen it.
Analyze the report. Describe the likely issue and choose a severity of low, medium, or high.`;
```
Run the script:

    npx tsx src/demo1/api_req.ts

Look at the response. It will likely contain a severity and an explanation in plain text. How could you extract those details programmatically? For example, what might happen if the model changes the wording or order of its response?

To make the response more predictable, we’ll ask the model to return structured data.

**Student task:** Open `src/demo1/structured_req.ts` and write a system prompt that request a JSON object with these fields:

- `severity`: `"low"`, `"medium"`, `"high"`, or `"unknown"`
- `reason`: a text explanation for the selected severity

You do not need to include any user input in the system prompt, we have included the user input for you.

For example, the expected output could look like this:
```json
    {
      "severity": "medium",
      "reason": "The report describes lost changes, which disrupts the user’s work, but does not indicate a broader system failure."
    }
```
Run the structured-request script:
```bash
npx tsx src/demo1/structured_req.ts
```
Check that the result is a JSON object and that `severity` uses one of the allowed values. This predictable format is easier for an application to parse and use.

### 1.1.3 Few-shot prompting (short-term memory)

The response now has a predictable JSON structure, but the `reason` field can still vary in style and detail. We can give the model examples to show the kind of explanation we want.

Open `src/demo1/structured_req.ts` and add one or two examples to the prompt. Each example should include a bug report and the expected JSON response. Use the examples to demonstrate a consistent pattern for writing the `reason`, such as:
```txt
> **Impact:** [effect on the user]. **Scope:** [who or what is affected].

For example:

    Bug report: The search button does nothing.
    Response:
    {
      "severity": "medium",
      "reason": "Impact: Users cannot search. Scope: All users of the search page."
    }
```

Then run the script again:

    npx tsx src/demo1/structured_req.ts

Compare the new response with the previous one. Does the model follow the example’s `reason` format?
This is a simple form of **model memory**: the examples give the model context to follow while generating its response. More specifically, this technique is called **few-shot prompting** or **in-context learning**. The model only has access to the examples when they are included in the current prompt, so the application must provide them again for future requests.

## 1.2 Creating Tool-Calling LLMs with MCP

Our bug-categorization LLM now returns structured output. However, it is assigning severity based on general knowledge instead of following our project’s rules. We want its classifications to follow a specific bug-categorization manual.

**Student task:** Open `src/demo1/structured_req.ts` and edit the system prompt:
```ts
const sys_input = `Categorize the bug using the bug-categorization manual.
If the manual has not been provided, do not guess. Set severity to "unknown" and explain in the reason that you need the manual.

Return only a JSON object with:
- "severity": "low", "medium", "high", or "unknown"
- "reason": a short explanation`;
```
Run the script and inspect the output. Because the manual has not been provided yet, the model should return `"unknown"` and explain that it needs the manual to categorize the bug.

In the next steps, we’ll make the manual available to the model through an MCP tool.

### 1.2.1 Creating an MCP Server

The LLM has indicated that it needs the bug-categorization manual before it can assign a severity. We’ll make the manual available through an MCP server.

Open `src/demo1/manual_server.ts`. In this file, define the manual’s severity rules and expose them through a tool named `get_bug_categorization_manual`. Once we connect the server to an MCP client, the LLM will be able to request the manual when it needs it.

The server registers the tool with a name and description so an MCP client—and, later, the LLM—can discover its purpose. When called, the tool returns the manual text. The MCP SDK’s `registerTool` function defines the tool, and `serveStdio` makes the server available to a local host process.

**Student task:** Write or revise the severity rules in the manual. We will use these rules later.

### 1.2.2 Link the Server to the Application with an MCP Client

The MCP server provides the bug-severity manual as a tool. We’ll connect the server to our application through an MCP client, then make the tool available to the LLM.

The MCP client is part of the application. It connects to the MCP server, discovers the tools the server provides, and relays tool calls and results between the application and server. The LLM does not connect to the MCP server directly; the application handles that connection.

Open `src/demo1/mcp_req.ts`. In this step, you’ll set up the client connection and inspect the tools provided by the server.

**Student task:** Set `serverPath` to the file path of `manual_server.ts`. In this project, the server file is located at `src/demo1/manual_server.ts`.

### 1.2.3 Run the Client and Inspect the Server’s Tools

The MCP client starts the server as a child process, so you only need to run the client script. You do not need to start the server separately in another terminal.

Run:
```bash
npx tsx src/demo1/mcp_req.ts
```
The client should connect to the server and print the tools it discovers in the console. Confirm that the list includes `get_bug_categorization_manual`.

### 1.2.4 Connect the Tool to the LLM

Open `src/demo1/tool_req.ts`. This script acts as the application: it calls the LLM API and creates an MCP client. The client starts the MCP server, discovers its tools, and passes their definitions to the LLM.

If the LLM requests a tool, the application calls it through the MCP client and sends the result back to the LLM. The model can then use that result to complete its response.

In `tool_req.ts`, set `serverPath` to the path of the server script, `src/demo1/manual_server.ts`, and run the application:
```bash
npx tsx src/demo1/tool_req.ts
```
You should see the LLM’s response printed in the console. Check whether it calls `get_bug_categorization_manual` to retrieve the manual before categorizing the bug.

### Conclusion

You’ve created an application that gives an LLM access to the bug-categorization manual through an MCP tool. The application connects to the MCP server, handles the tool call, and returns the manual to the model so it can use the project’s rules to categorize a bug.