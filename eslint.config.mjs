import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "mcp/node_modules/**",
      "src/generated/**",
      // Generated from beyondles-ai/beyondles-shared; never edited here.
      "src/components/share/**",
      "src/lib/platform-client/**",
    ],
  },
];

export default eslintConfig;
