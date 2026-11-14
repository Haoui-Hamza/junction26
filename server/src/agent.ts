import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import type { IntakeResult } from "./domain/intake.js";

export interface AgentActivity {
  type: "status" | "tool_call" | "tool_result" | "assistant";
  at: string;
  [key: string]: unknown;
}

interface AgentInput {
  text: string;
  intake: IntakeResult;
  apiKey: string;
  model: string;
  agentToken: string;
  onActivity: (activity: AgentActivity) => void;
}

const ALLOWED_TOOLS = new Set(["search_products", "compare_offers"]);

function getTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) =>
      typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string"
        ? block.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

export async function runPurchasingAgent(input: AgentInput): Promise<void> {
  const emit = (activity: Omit<AgentActivity, "at">) => input.onActivity({ ...activity, at: new Date().toISOString() } as AgentActivity);
  const openai = new OpenAI({ apiKey: input.apiKey, timeout: 60_000, maxRetries: 1 });
  const client = new Client({ name: "aimo-order-guard-agent", version: "0.1.0" });
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("mcp/server.ts")],
    cwd: process.cwd(),
    env: { ...env, ORDER_GUARD_URL: `http://localhost:${process.env.PORT || "3000"}`, AGENT_TOKEN: input.agentToken },
    stderr: "pipe",
  });

  try {
    emit({ type: "status", stage: "mcp_connect", message: "Connecting to the purchasing tools…" });
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = listed.tools
      .filter((tool) => ALLOWED_TOOLS.has(tool.name))
      .map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description ?? tool.name,
          parameters: tool.inputSchema as Record<string, unknown>,
        },
      }));
    if (tools.length !== ALLOWED_TOOLS.size) throw new Error("The MCP server is missing one or more required purchasing tools");

    emit({ type: "status", stage: "agent", message: "The agent is reviewing your request and selecting purchasing tools…" });
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content:
          "You are a careful B2B kitchen shopping assistant. Use search_products and compare_offers to find and explain a suitable option. " +
          "Never place or request an order; a person must review the recommendation and confirm the next step in the UI. " +
          "Respect any hard budget limit, and clearly say when no option fits it. " +
          "If compare_offers reports searchBounded, explain that not all combinations were checked and do not claim the recommendation is the cheapest or that no exact match exists. " +
          "Never reveal credentials or private reasoning.",
      },
      {
        role: "user",
        content: JSON.stringify({
          originalRequest: input.text,
          structuredRequest: input.intake.draft,
          instruction: "Find and compare suitable offers. Do not request or place an order; wait for the buyer to review the recommendation.",
        }),
      },
    ];

    for (let turn = 0; turn < 8; turn += 1) {
      const response = await openai.chat.completions.create({
        model: input.model,
        max_tokens: 1800,
        tools,
        tool_choice: "auto",
        messages,
      });
      const message = response.choices[0]?.message;
      if (!message) throw new Error("OpenAI returned an empty agent response");
      messages.push(message);

      const toolUses = message.tool_calls?.filter((tool): tool is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => tool.type === "function") ?? [];
      if (!toolUses.length) {
        const answer = message.content?.trim() ?? "";
        emit({ type: "assistant", message: answer || "The purchasing tools completed, but the agent returned no summary." });
        return;
      }

      for (const use of toolUses) {
        const toolName = use.function.name;
        if (!ALLOWED_TOOLS.has(toolName)) throw new Error(`The model requested an unsupported tool: ${toolName}`);
        const args: unknown = JSON.parse(use.function.arguments);
        if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error(`The model returned invalid arguments for ${toolName}`);
        emit({ type: "tool_call", tool: toolName, input: args });
        const result = await client.callTool({ name: toolName, arguments: args as Record<string, unknown> });
        const text = getTextContent(result.content);
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          if (!text) throw new Error(`MCP tool ${toolName} returned an empty result`);
        }
        const isError = typeof result.isError === "boolean" && result.isError;
        emit({ type: "tool_result", tool: toolName, result: parsed, isError });
        messages.push({ role: "tool", tool_call_id: use.id, content: text || "No content returned" });
      }
    }

    throw new Error("The agent reached the maximum number of tool-use turns");
  } finally {
    await client.close();
  }
}
