import { z } from "zod";

/**
 * The input and output shapes of the notes functions. ONE copy: the routes
 * parse with them, the server actions parse with them, and the OpenAPI
 * document (`/api/v1/openapi.json`) is generated from them. No database
 * import here, so the manifest and the OpenAPI builder can load it anywhere.
 */

const visibilityRequest = z
  .enum(["private", "organisation"])
  .describe(
    "Who sees the note. Left out: private to the acting person; a credential without a person must name 'organisation'.",
  );

export const noteInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).default(""),
  visibility: visibilityRequest.optional(),
});
export type NoteInput = z.infer<typeof noteInputSchema>;

export const noteUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(20_000).optional(),
    visibility: visibilityRequest.optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.body !== undefined ||
      v.visibility !== undefined,
    {
      message: "Name at least one of title, body, visibility.",
    },
  );
export type NoteUpdate = z.infer<typeof noteUpdateSchema>;

export const listNotesQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListNotesQuery = z.infer<typeof listNotesQuerySchema>;

export const noteIdSchema = z.uuid();

export const expireNotesSchema = z.object({
  olderThanDays: z.number().int().min(1).max(3650),
  /** Dry unless the caller sends `false` (src/server/jobs/deletion-guard.ts). */
  dryRun: z.boolean().default(true),
});
export type ExpireNotesInput = z.infer<typeof expireNotesSchema>;

/** The note as every door returns it. */
export const noteSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  visibility: z.enum(["PRIVATE", "COLLECTION", "ORGANISATION"]),
  ownerUserId: z.string(),
  collectionId: z.string().nullable(),
  createdAt: z.string().describe("ISO 8601"),
  updatedAt: z.string().describe("ISO 8601"),
});

export const noteEnvelope = z.object({ data: noteSchema });
export const noteListEnvelope = z.object({ data: z.array(noteSchema) });
export const deletedEnvelope = z.object({
  data: z.object({ id: z.string(), deleted: z.literal(true) }),
});
export const expiredEnvelope = z.object({
  data: z.object({ deleted: z.number().int(), expired: z.number().int(), dryRun: z.boolean() }),
});
