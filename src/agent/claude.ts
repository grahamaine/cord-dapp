/**
 * Optional Claude brain for ProcureBot. Used ONLY when ANTHROPIC_API_KEY is set in .env;
 * otherwise Cord uses the free built-in assistant (src/agent/builtin.ts). Same tools, same
 * limits: the model can prepare payments but has no tool to release them.
 */
import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, toolByName } from "./tools.js";
import type { AgentAction, AgentReply } from "./builtin.js";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const SYSTEM = `You are ProcureBot, the AI purchasing agent inside Kakasa, used by an organisation in Uganda to pay suppliers and service providers on Concordium.
- Amounts are in demo EUR. Default limits: €10,000 per payment and €10,000 per day.
- You can list invoices and locks, PREPARE payments (create → fund → agent checks), cancel locks, check the budget, verify suppliers (also on other blockchains via CIS-8), buy tender lists or price benchmarks, and summarise the audit trail.
- You can NOT release payments. After preparing one, tell the owner to open Locks and press Release, which their wallet signs. Never claim a payment was made unless a tool result shows it.
- If a tool refuses (limit, unverified supplier, paused agent), explain the reason plainly and suggest the owner's options. Don't try to work around a refusal.
- Ask before buying paid data unless the owner asked for it. Be brief and concrete; use short bullet lists.`;

export const claudeEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

export async function claudeReply(history: { role: "user" | "assistant"; content: string }[]): Promise<AgentReply> {
  const client = new Anthropic();
  const tools = TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  const messages: any[] = history.slice(-20).map((m) => ({ role: m.role, content: m.content }));
  const actions: AgentAction[] = [];
  for (let turn = 0; turn < 8; turn++) {
    const res: any = await client.messages.create({ model: MODEL, max_tokens: 1024, system: SYSTEM, tools: tools as any, messages });
    messages.push({ role: "assistant", content: res.content });
    const calls = res.content.filter((b: any) => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || !calls.length) {
      const reply = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      return { reply: reply || "Done.", actions, mode: "claude" };
    }
    const results = [];
    for (const c of calls) {
      const tool = toolByName(c.name);
      let result: unknown;
      try { result = tool ? await tool.run(c.input ?? {}) : { error: `unknown tool ${c.name}` }; }
      catch (e) { result = { error: (e as Error).message }; }
      actions.push({ tool: c.name, input: c.input ?? {}, result });
      results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(result).slice(0, 20_000) });
    }
    messages.push({ role: "user", content: results });
  }
  return { reply: "I stopped after several steps; please check the Locks tab.", actions, mode: "claude" };
}
