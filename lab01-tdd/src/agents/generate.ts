import {
  Agent,
  AgentsError,
  tool,
  type ToolToFinalOutputFunction,
} from "@openai/agents";
import { z } from "zod";

import type { ArtifactKind } from "../generation/artifact.js";
import { ArtifactExtractionError } from "../generation/artifact.js";
import { AgentFileWorkspace } from "./file-workspace.js";
import { CourseModelRuntime, snapshotUsage, type UsageSnapshot } from "./runtime.js";
import { testAuthoringInstructions, testRepairPolicy } from "./test-authoring-instructions.js";

export type CourseScenario = "api" | "gui";

export interface GenerationInput {
  readonly scenario: CourseScenario;
  readonly publicBrief: string;
  readonly executionContract: string;
  readonly artifactPath: string;
  readonly signal?: AbortSignal;
}

export interface GenerationResult {
  readonly content: string;
  readonly rawOutput: string;
  readonly usage: UsageSnapshot;
  readonly rawResponses: readonly unknown[];
  readonly prompt?: { readonly instructions: string; readonly input: string };
}

/** Preserves billable inference evidence when artifact delivery fails afterwards. */
export class GenerationArtifactError extends ArtifactExtractionError {
  readonly usage: UsageSnapshot;
  readonly rawOutput: string;
  readonly rawResponses: readonly unknown[];
  readonly prompt: { readonly instructions: string; readonly input: string };

  constructor(
    message: string,
    evidence: Omit<GenerationResult, "content">,
    options?: { readonly cause?: unknown },
  ) {
    super(message);
    this.name = "GenerationArtifactError";
    this.usage = evidence.usage;
    this.rawOutput = evidence.rawOutput;
    this.rawResponses = evidence.rawResponses;
    this.prompt = evidence.prompt!;
    if (options && "cause" in options) this.cause = options.cause;
  }
}

export function generationArtifactErrorFromRunnerError(
  error: unknown,
  prompt: { readonly instructions: string; readonly input: string },
): GenerationArtifactError | undefined {
  if (!(error instanceof AgentsError) || error.state === undefined) {
    return undefined;
  }
  return new GenerationArtifactError(
    error instanceof Error ? error.message : String(error),
    {
      rawOutput: "",
      usage: snapshotUsage(error.state.usage),
      rawResponses: error.state._modelResponses,
      prompt,
    },
    { cause: error },
  );
}

export interface TestRepairInput extends GenerationInput {
  readonly currentTests: string;
  readonly referenceStatus: "TEST_ERROR" | "RED";
  readonly referenceFeedback: string;
}

function createWriteFileTool(workspace: AgentFileWorkspace, description: string) {
  return tool({
    name: "write_file",
    description: `${description} The only authorized path is ${workspace.allowedPath}.`,
    parameters: z.object({
      path: z.literal(workspace.allowedPath),
      content: z.string().min(1),
    }),
    execute: ({ path, content }) => workspace.writeFile(path, content),
  });
}

export const acceptedWriteToolUseBehavior: ToolToFinalOutputFunction = (
  _context,
  toolResults,
) => {
  let acceptedOutput: unknown;
  for (const result of toolResults) {
    if (
      result.type === "function_output" &&
      typeof result.output === "object" &&
      result.output !== null &&
      "accepted" in result.output &&
      result.output.accepted === true
    ) {
      acceptedOutput = result.output;
      break;
    }
  }
  if (acceptedOutput === undefined) {
    return { isFinalOutput: false, isInterrupted: undefined };
  }
  return {
    isFinalOutput: true,
    isInterrupted: undefined,
    finalOutput:
      typeof acceptedOutput === "string"
        ? acceptedOutput
        : JSON.stringify(acceptedOutput),
  };
};

function isMalformedToolArgumentsError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && !visited.has(current)) {
    visited.add(current);
    if (current instanceof SyntaxError) {
      const message = current.message.toLowerCase();
      if (
        message.includes("not valid json") ||
        message.includes("json parse") ||
        message.includes(" in json") ||
        /unexpected (?:token|character).*json/.test(message)
      ) {
        return true;
      }
    }
    current =
      typeof current === "object" && "cause" in current
        ? current.cause
        : undefined;
  }

  return false;
}

async function runWithMalformedToolArgumentsRewrite<T>(
  promptInput: string,
  run: (input: string) => Promise<T>,
): Promise<T> {
  try {
    return await run(promptInput);
  } catch (error) {
    if (!isMalformedToolArgumentsError(error)) throw error;
    return run(
      [
        promptInput,
        "Your previous response could not be executed because the write_file tool arguments were malformed and were not valid JSON.",
        "Retry the task from scratch now. Call write_file exactly once with arguments matching its schema, put the complete artifact in the content field, and return no prose.",
      ].join("\n\n"),
    );
  }
}

async function runGeneration(
  runtime: CourseModelRuntime,
  input: GenerationInput,
  role: "implementation" | "tests",
): Promise<GenerationResult> {
  const artifactKind: ArtifactKind = `${input.scenario}-${role}`;
  const workspace = new AgentFileWorkspace({
    artifactKind,
    allowedPath: input.artifactPath,
    writeLabel: role === "implementation" ? "implementation" : "test suite",
  });
  const writeFile = createWriteFileTool(
    workspace,
    role === "implementation"
      ? "Write the complete generated implementation."
      : "Write the complete generated train-test suite.",
  );
  const instructions = [
    role === "implementation"
      ? input.scenario === "api"
        ? "Produce a concise first-pass implementation. Prefer straightforward logic and minimal code."
        : "Create the complete implementation described by the public task."
      : "Create a complete executable train-test suite for the registration task.",
    ...(role === "tests"
      ? [
          "Think carefully about normalization, boundary conditions, malformed input, failed state transitions, duplicate handling, accessibility, persistence, and sensitive-data safety where applicable. Every test must make a meaningful externally observable assertion.",
          testAuthoringInstructions(input.scenario),
        ]
      : []),
    `Use write_file to save the complete artifact to ${workspace.allowedPath}.`,
    "You may write only that file. Do not merely print the source as your final answer.",
    `Follow this execution contract exactly.\n\n${input.executionContract}`,
  ].join("\n\n");
  const promptInput = `Registration task:\n\n${input.publicBrief}`;
  const agent = new Agent({
    name: role === "implementation" ? "Implementation File Agent" : "Test File Agent",
    model: runtime.config.model,
    modelSettings: {
      ...runtime.modelSettingsFor(
        role === "implementation" ? "direct" : "test-generation",
      ),
      toolChoice: "required",
    },
    instructions,
    tools: [writeFile],
    toolUseBehavior: acceptedWriteToolUseBehavior,
    resetToolChoice: false,
  });
  let result;
  try {
    result = await runWithMalformedToolArgumentsRewrite(
      promptInput,
      (attemptInput) =>
        runtime.runner.run(agent, attemptInput, {
          maxTurns: 6,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
    );
  } catch (error) {
    throw (
      generationArtifactErrorFromRunnerError(error, {
        instructions,
        input: promptInput,
      }) ?? error
    );
  }
  const evidence = {
    rawOutput: typeof result.finalOutput === "string" ? result.finalOutput : "",
    usage: snapshotUsage(result.state.usage),
    rawResponses: result.rawResponses,
    prompt: { instructions, input: promptInput },
  };
  let content: string;
  try {
    content = await workspace.readWrittenFile();
  } catch (error) {
    throw new GenerationArtifactError(
      error instanceof Error ? error.message : String(error),
      evidence,
      { cause: error },
    );
  }

  return {
    content,
    ...evidence,
  };
}

export async function generateDirectImplementation(
  runtime: CourseModelRuntime,
  input: GenerationInput,
): Promise<GenerationResult> {
  return runGeneration(runtime, input, "implementation");
}

export async function generateTrainTests(
  runtime: CourseModelRuntime,
  input: GenerationInput,
): Promise<GenerationResult> {
  return runGeneration(runtime, input, "tests");
}

export async function repairTrainTests(
  runtime: CourseModelRuntime,
  input: TestRepairInput,
): Promise<GenerationResult> {
  const workspace = new AgentFileWorkspace({
    artifactKind: `${input.scenario}-tests`,
    allowedPath: input.artifactPath,
    writeLabel: "test-suite rewrite",
    rejectUnchangedFrom: input.currentTests,
  });
  const writeFile = tool({
    name: "write_file",
    description: "Repair the existing train suite with exact text replacements. The harness writes the complete resulting file. Each old_text must occur exactly once in the current suite.",
    parameters: z.object({
      path: z.literal(workspace.allowedPath),
      edits: z.array(z.object({
        reason: z.string().min(1).describe("Derive the correct expectation from the policy and actual submitted data before proposing the edit."),
        old_text: z.string().min(1),
        new_text: z.string().min(1),
      })).min(1),
    }),
    execute: ({ path, edits }) => {
      let content = input.currentTests;
      for (const edit of edits) {
        const index = content.indexOf(edit.old_text);
        if (index < 0 || content.indexOf(edit.old_text, index + 1) >= 0) {
          return { accepted: false, message: "Each old_text must match exactly one source fragment. Include enough context to make the edit unambiguous." };
        }
        if (edit.old_text === edit.new_text) {
          return { accepted: false, message: "The replacement is unchanged. Correct the reported test defect." };
        }
        content = content.slice(0, index) + edit.new_text + content.slice(index + edit.old_text.length);
      }
      return workspace.writeFile(path, content);
    },
  });
  const instructions = [
    "Repair the generated executable train-test suite. The teacher reference satisfies the supplied policy; failures against it indicate defects in the tests.",
    input.referenceStatus === "TEST_ERROR"
      ? "Fix its syntax, loading, collection, forbidden-access, or execution-contract problem."
      : "Trace each failing assertion back to the data actually submitted, including helper calls and transformations. Derive the expected result by applying the supplied policy to that submitted data, then correct the faulty fixture, locator, state setup, or expectation. Do not transform observed results to hide a mismatch.",
    "Make the smallest substantive correction. Preserve unrelated tests and supported coverage; do not delete or skip failing tests, or weaken assertions merely to obtain a passing result.",
    "Call write_file exactly once with minimal edits. For each edit, first explain the policy-derived correction in reason, then provide the exact old_text and corrected new_text. Do not reproduce the complete suite or output prose. The tool writes the complete resulting source required by the execution contract.",
    "Use only the task, the supplied test-authoring instructions, test contract, current suite, and bounded runner feedback. Do not attempt to inspect the implementation, reference implementation, validation files, repository, working directory, or run artifacts.",
    testRepairPolicy(input.scenario),
    `Use write_file to apply the corrections to ${workspace.allowedPath}.`,
    `Follow this execution contract exactly:\n\n${input.executionContract}`,
  ].join("\n\n");
  const promptInput = [
    `Reference status: ${input.referenceStatus}`,
    `Reference feedback:\n\n${input.referenceFeedback}`,
    `Registration task:\n\n${input.publicBrief}`,
    `Current train tests:\n\n${input.currentTests}`,
    "Correct the reported disagreement using the policy applied to the actual submitted data. Preserve assertion strength and unrelated tests. Submit only the necessary text replacements now.",
  ].join("\n\n---\n\n");
  const agent = new Agent({
    name: "Test File Repair Agent",
    model: runtime.config.model,
    modelSettings: {
      ...runtime.modelSettingsFor("test-repair"),
      toolChoice: "required",
    },
    instructions,
    tools: [writeFile],
    toolUseBehavior: acceptedWriteToolUseBehavior,
    resetToolChoice: false,
  });
  let result;
  try {
    result = await runWithMalformedToolArgumentsRewrite(
      promptInput,
      (attemptInput) =>
        runtime.runner.run(agent, attemptInput, {
          maxTurns: 6,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
    );
  } catch (error) {
    throw (
      generationArtifactErrorFromRunnerError(error, {
        instructions,
        input: promptInput,
      }) ?? error
    );
  }
  const evidence = {
    rawOutput: typeof result.finalOutput === "string" ? result.finalOutput : "",
    usage: snapshotUsage(result.state.usage),
    rawResponses: result.rawResponses,
    prompt: { instructions, input: promptInput },
  };
  let content: string;
  try {
    content = await workspace.readWrittenFile();
  } catch (error) {
    throw new GenerationArtifactError(
      error instanceof Error ? error.message : String(error),
      evidence,
      { cause: error },
    );
  }

  return {
    content,
    ...evidence,
  };
}
