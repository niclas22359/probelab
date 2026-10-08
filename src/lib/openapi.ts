import { z } from "zod";

import { LAB_KEY, LAB_NAME } from "@/lib/lab";
import { ALL_SCOPES, LAB_SCOPES } from "@/lib/scopes";
import {
  FUNCTIONS,
  type FunctionEntry,
  type RestDoor,
} from "@/server/functions.manifest";

/**
 * The OpenAPI 3.1 document of `/api/v1`, built from the functions manifest
 * and the zod schemas the routes parse with (zod's own `z.toJSONSchema`, no
 * extra dependency). There is no hand-written copy to drift.
 *
 * Each operation carries `x-required-scopes` and, for worker routes,
 * `x-worker-only: true`.
 */

type Json = Record<string, unknown>;

const errorEnvelope: Json = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
  },
};

function schemaOf(schema: z.ZodType, io: "input" | "output"): Json {
  const out = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Json;
  delete out.$schema;
  return out;
}

function queryParameters(schema: z.ZodType): Json[] {
  const json = schemaOf(schema, "input");
  const properties = (json.properties ?? {}) as Record<string, Json>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: property,
  }));
}

function pathParameters(path: string): Json[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
}

function operation(id: string, entry: FunctionEntry, rest: RestDoor): Json {
  const status = String(rest.status ?? 200);
  const errors = Object.fromEntries(
    [
      ["400", "Invalid input"],
      ["401", "Missing or invalid credential"],
      ["403", "Not allowed: access, scope or worker-only"],
      ["404", "Not found or not visible"],
      ["429", "Rate limit; see Retry-After"],
    ].map(([code, description]) => [
      code,
      {
        description,
        content: { "application/json": { schema: errorEnvelope } },
      },
    ]),
  );
  return {
    operationId: id,
    summary: rest.summary,
    "x-required-scopes": [...entry.scopes],
    ...(entry.trigger === "worker" ? { "x-worker-only": true } : {}),
    parameters: [
      ...pathParameters(rest.path),
      ...(rest.query ? queryParameters(rest.query) : []),
    ],
    ...(rest.body
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: schemaOf(rest.body, "input") },
            },
          },
        }
      : {}),
    responses: {
      [status]: {
        description: "Success",
        content: {
          "application/json": { schema: schemaOf(rest.response, "output") },
        },
      },
      ...errors,
    },
  };
}

export function buildOpenApi(input: {
  appUrl: string | null;
  functions?: Readonly<Record<string, FunctionEntry>>;
}): Json {
  const functions = input.functions ?? FUNCTIONS;
  const paths: Record<string, Record<string, Json>> = {};
  for (const [id, entry] of Object.entries(functions)) {
    if ("excluded" in entry.rest) continue;
    const rest = entry.rest;
    paths[rest.path] ??= {};
    paths[rest.path][rest.method.toLowerCase()] = operation(id, entry, rest);
  }
  const base = input.appUrl?.trim().replace(/\/+$/, "");
  const extra = Object.entries(LAB_SCOPES).map(
    ([name, label]) => `\`${name}\`: ${label.en}`,
  );
  return {
    openapi: "3.1.0",
    info: {
      title: `${LAB_NAME} API`,
      version: "1",
      description:
        `The HTTP door of ${LAB_NAME} (${LAB_KEY}). Same functions, permissions and audit as the screen and the ` +
        `MCP tool door (/api/mcp). Scopes: ${ALL_SCOPES.join(", ")}. ${extra.join(". ")}.`,
    },
    ...(base ? { servers: [{ url: base }] } : {}),
    components: {
      securitySchemes: {
        apiKey: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "A key of this Lab (settings page).",
        },
        onBehalf: {
          type: "http",
          scheme: "bearer",
          description: "An on-behalf token the platform signed for this Lab.",
        },
      },
    },
    security: [{ apiKey: [] }, { onBehalf: [] }],
    paths,
  };
}
