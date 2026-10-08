import { describe, expect, it } from "vitest";

import { LAB_KEY, TOOL_PREFIX } from "@/lib/lab";
import { TOOL_DEFINITIONS } from "@/lib/mcp/catalog";
import {
  TOOL_CAPABILITIES,
  TOOL_CAPABILITY_META_KEY,
  TOOL_NAME_MAX,
  TOOL_PREFIX_PATTERN,
  catalogProblems,
  toolAnnotations,
  toolMeta,
  type ToolMarker,
} from "@/lib/tool-door/markers";

/**
 * The catalogue rule of the connection layer contract, stage 6, 2.4: one
 * declared prefix, names of at most 48 characters, a marker and a title on
 * every tool, capability tags only where the contract names them.
 */

const read: ToolMarker = { access: "read", idempotent: true, title: { de: "Notizen auflisten", en: "List notes" } };
const write: ToolMarker = { access: "write", idempotent: false, title: { de: "Notiz anlegen", en: "Create a note" } };

describe("the template's catalogue", () => {
  it("follows the catalogue rule", () => {
    expect(catalogProblems(TOOL_DEFINITIONS, TOOL_PREFIX)).toEqual([]);
  });

  it("declares its prefix once, from the Lab key", () => {
    expect(TOOL_PREFIX).toBe(`${LAB_KEY}_`);
    expect(TOOL_PREFIX_PATTERN.test(TOOL_PREFIX)).toBe(true);
  });

  it("carries exactly the markers of the contract", () => {
    expect(TOOL_DEFINITIONS.map((t) => [t.name, t.access, t.idempotent])).toEqual([
      ["examplelab_list_notes", "read", true],
      ["examplelab_get_note", "read", true],
      ["examplelab_create_note", "write", false],
      ["examplelab_update_note", "write", true],
      ["examplelab_delete_note", "destructive", false],
    ]);
  });

  it("has no capability tag on any tool (none of the template's tools leaves the organisation)", () => {
    expect(TOOL_DEFINITIONS.filter((t) => t.capability !== undefined).map((t) => t.name)).toEqual([]);
  });
});

describe("catalogProblems", () => {
  const tool = (name: string, marker: Partial<ToolMarker> = read) => ({ name, ...marker });

  it("accepts a clean catalogue", () => {
    expect(catalogProblems([tool("demo_list"), tool("demo_create", write)], "demo_")).toEqual([]);
  });

  it("refuses a prefix that breaks the pattern", () => {
    for (const prefix of ["demo", "Demo_", "d_", "1demo_", "averyveryverylongx_"]) {
      expect(catalogProblems([], prefix), prefix).toHaveLength(1);
    }
  });

  it("refuses a name without the prefix or with other characters", () => {
    expect(catalogProblems([tool("other_list")], "demo_")[0]).toContain('"other_list"');
    expect(catalogProblems([tool("demo_List")], "demo_")).toHaveLength(1);
    expect(catalogProblems([tool("demo_")], "demo_")).toHaveLength(1);
  });

  it("accepts 48 characters and refuses 49", () => {
    const at48 = `demo_${"a".repeat(TOOL_NAME_MAX - 5)}`;
    const at49 = `${at48}a`;
    expect(at48).toHaveLength(48);
    expect(catalogProblems([tool(at48)], "demo_")).toEqual([]);
    const problems = catalogProblems([tool(at49)], "demo_");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("longer than 48");
  });

  it("refuses a duplicate name", () => {
    const problems = catalogProblems([tool("demo_list"), tool("demo_list")], "demo_");
    expect(problems).toEqual(['tool "demo_list": name is not unique']);
  });

  it("refuses a tool without a marker", () => {
    const problems = catalogProblems([{ name: "demo_list" }], "demo_");
    expect(problems).toEqual([
      'tool "demo_list": access must be read, write or destructive',
      'tool "demo_list": idempotent must be a boolean',
      'tool "demo_list": title.de missing',
      'tool "demo_list": title.en missing',
    ]);
  });

  it("refuses an empty or too long title", () => {
    expect(catalogProblems([tool("demo_list", { ...read, title: { de: "", en: "List" } })], "demo_")).toHaveLength(1);
    expect(
      catalogProblems([tool("demo_list", { ...read, title: { de: "Auflisten", en: "x".repeat(61) } })], "demo_"),
    ).toHaveLength(1);
  });

  it("refuses a read tool that is not idempotent", () => {
    expect(catalogProblems([tool("demo_list", { ...read, idempotent: false })], "demo_")).toEqual([
      'tool "demo_list": a read tool must be idempotent',
    ]);
  });

  it("refuses an unknown capability", () => {
    const marker = { ...write, capability: "money.spend" } as unknown as ToolMarker;
    expect(catalogProblems([tool("demo_pay", marker)], "demo_")[0]).toContain("capability must be one of");
  });

  it("refuses a capability on a read tool", () => {
    expect(catalogProblems([tool("demo_list", { ...read, capability: "mail.send" })], "demo_")).toEqual([
      'tool "demo_list": a capability belongs on a write or destructive tool only',
    ]);
  });

  it("accepts every known capability on a write or destructive tool", () => {
    for (const capability of TOOL_CAPABILITIES) {
      expect(catalogProblems([tool("demo_send", { ...write, capability })], "demo_")).toEqual([]);
      expect(
        catalogProblems([tool("demo_send", { ...write, access: "destructive", capability })], "demo_"),
      ).toEqual([]);
    }
  });
});

describe("toolAnnotations", () => {
  it("read: read only, not destructive", () => {
    expect(toolAnnotations(read)).toEqual({
      title: "List notes",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("write: neither read only nor destructive", () => {
    expect(toolAnnotations(write)).toEqual({
      title: "Create a note",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("destructive: destructive, idempotency from the marker", () => {
    expect(
      toolAnnotations({ access: "destructive", idempotent: true, title: { de: "Löschen", en: "Delete" } }),
    ).toEqual({ title: "Delete", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
  });
});

describe("toolMeta", () => {
  it("carries the capability under its key, and nothing without one", () => {
    expect(TOOL_CAPABILITY_META_KEY).toBe("ai.beyondles/capability");
    expect(toolMeta({ ...write, capability: "mail.send" })).toEqual({ "ai.beyondles/capability": "mail.send" });
    expect(toolMeta(write)).toBeUndefined();
  });
});
