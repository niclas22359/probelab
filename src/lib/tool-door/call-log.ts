/**
 * One log line per `tools/call` at a Lab's tool door (connection layer contract, stage 6, 2.4).
 *
 * The Labs have no call log of their own and the platform's protocol is not one, so the process
 * log carries one line per call: who called (credential, calling product, organisation, person,
 * agent level), which tool, and whether it worked. Never arguments, never results.
 *
 * THIS FILE IS COPIED VERBATIM into every Lab from the template `beyondles-lab`. Node runtime only.
 */

export function logToolCall(entry: {
  via: "api-key" | "on-behalf";
  callingProduct: string | null;
  organisationId: string;
  userId: string | null;
  agentLevel: string | null;
  tool: string;
  outcome: "ok" | "error";
  tokenId: string | null;
}): void {
  const field = (value: string | null): string => (value && value.trim() ? value.replace(/\s+/g, "_") : "-");
  console.log(
    `[tool-door] via=${entry.via} cp=${field(entry.callingProduct)} org=${field(entry.organisationId)} ` +
      `sub=${field(entry.userId)} agent=${field(entry.agentLevel)} tool=${field(entry.tool)} ` +
      `outcome=${entry.outcome} jti=${field(entry.tokenId)}`,
  );
}
