import { describe, expect, it } from "vitest";

import de from "../../messages/de.json";
import en from "../../messages/en.json";
import { LOCALES } from "@/i18n/config";
import { parseAcceptLanguage } from "@/i18n/locale";

/** Both shipped languages must carry EXACTLY the same keys and placeholders. */
function collectKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const p = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? collectKeys(value as Record<string, unknown>, p)
      : [p];
  });
}

function placeholders(text: string): string[] {
  const names: string[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (text[i] !== "{") continue;
    if (depth === 0) {
      const hit = /^(\w+)\s*[,}]/.exec(text.slice(i + 1));
      if (hit) names.push(hit[1]);
    }
    depth += 1;
  }
  return names.sort();
}

const valueAt = (tree: Record<string, unknown>, p: string): unknown =>
  p.split(".").reduce<unknown>((cur, part) => (cur as Record<string, unknown> | undefined)?.[part], tree);

describe("messages", () => {
  const deKeys = collectKeys(de).sort();
  const enKeys = collectKeys(en).sort();

  it("ships exactly the languages that have files", () => {
    expect([...LOCALES].sort()).toEqual(["de", "en"]);
  });

  it("has the same keys in both languages", () => {
    expect(deKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    expect(enKeys.filter((k) => !deKeys.includes(k))).toEqual([]);
  });

  it("has no empty text and the same placeholders", () => {
    const diffs = deKeys.filter((p) => {
      const a = valueAt(de, p);
      const b = valueAt(en, p);
      if (typeof a !== "string" || typeof b !== "string") return false;
      if (a.trim() === "" || b.trim() === "") return true;
      return JSON.stringify(placeholders(a)) !== JSON.stringify(placeholders(b));
    });
    expect(diffs).toEqual([]);
  });
});

describe("parseAcceptLanguage", () => {
  it("picks the highest weighted supported language", () => {
    expect(parseAcceptLanguage("de-DE,de;q=0.9,en;q=0.8")).toBe("de");
    expect(parseAcceptLanguage("fr;q=0.9,en;q=0.8")).toBe("en");
    expect(parseAcceptLanguage("fr")).toBeNull();
  });
});
