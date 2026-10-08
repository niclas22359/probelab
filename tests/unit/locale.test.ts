import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import de from "../../messages/de.json";
import en from "../../messages/en.json";
import { parseStoredDate, toStoredDate } from "@/lib/dates";

/**
 * Locale guards (lab learnings, rule 12): every key the UI USES exists in
 * both languages (i18n.test.ts checks the two files match each other; this
 * one checks the code against them), and dates are stored in one format.
 */
const root = path.resolve(__dirname, "..", "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const has = (tree: unknown, key: string) =>
  key.split(".").reduce<unknown>((cur, part) => (cur as Record<string, unknown> | undefined)?.[part], tree) !== undefined;

/** `const t = useTranslations("ns")` / `getTranslations("ns")`, then `t("key")`. Literal keys only. */
function usedKeys(): string[] {
  const keys = new Set<string>();
  for (const file of sourceFiles(path.join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const bind of text.matchAll(/const\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*"([\w.]+)"\s*\)/g)) {
      const [, fn, ns] = bind;
      for (const call of text.matchAll(new RegExp(String.raw`\b${fn}(?:\.rich|\.markup)?\(\s*"([\w.]+)"`, "g"))) {
        keys.add(`${ns}.${call[1]}`);
      }
    }
  }
  return [...keys].sort();
}

describe("UI message keys", () => {
  const keys = usedKeys();
  it("finds the keys the UI uses", () => {
    expect(keys.length).toBeGreaterThan(5);
  });
  it.each(["de", "en"] as const)("every used key exists in %s", (lang) => {
    const messages = lang === "de" ? de : en;
    expect(keys.filter((k) => !has(messages, k))).toEqual([]);
  });
});

describe("stored dates", () => {
  it("stores ISO YYYY-MM-DD", () => {
    expect(toStoredDate(new Date("1980-02-03T23:30:00Z"))).toBe("1980-02-03");
  });
  it("refuses every format whose day/month order is a guess", () => {
    for (const v of ["03/02/1980", "02.03.1980", "1980-2-3", "1980-02-30", "1980-13-01", ""]) {
      expect(parseStoredDate(v)).toBeNull();
    }
    expect(parseStoredDate("1980-02-03")?.toISOString()).toBe("1980-02-03T00:00:00.000Z");
  });
});
