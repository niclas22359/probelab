import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Runs against a REAL, migrated Postgres (CI job "Migrations · postgres", or
 * locally with TEST_DATABASE_URL pointing at a throw-away database). Skipped
 * otherwise, so `npm test` stays offline.
 *
 * Proves the retention promise at the place it matters: after redaction, a
 * retried UPDATE with the old personal values is refused by the database.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("redaction against the real database", () => {
  const client = new Client({ connectionString: url });
  const org = `org-${Date.now()}`;

  beforeAll(async () => {
    await client.connect();
    await client.query(`INSERT INTO organisations (id, slug, name, "updatedAt") VALUES ($1, 'x', 'X', now())`, [org]);
  });
  afterAll(async () => {
    await client.query(`DELETE FROM organisations WHERE id = $1`, [org]);
    await client.end();
  });

  it("refuses to write personal data back over a redacted row", async () => {
    const { rows } = await client.query(
      `INSERT INTO notes (id, "organisationId", title, body, "ownerUserId", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, 'Passport Jane Doe', 'born 1980-02-03', 'u1', now()) RETURNING id`,
      [org],
    );
    const id = rows[0].id as string;
    await client.query(`UPDATE notes SET title = '[redacted]', body = '', "redactedAt" = now() WHERE id = $1`, [id]);

    await expect(
      client.query(`UPDATE notes SET title = 'Passport Jane Doe', body = 'born 1980-02-03' WHERE id = $1`, [id]),
    ).rejects.toThrow(/cannot be written back/);
    await expect(client.query(`UPDATE notes SET "redactedAt" = NULL WHERE id = $1`, [id])).rejects.toThrow();

    const after = await client.query(`SELECT title, body FROM notes WHERE id = $1`, [id]);
    expect(after.rows[0]).toEqual({ title: "[redacted]", body: "" });
    // Non-personal columns stay writable (e.g. visibility).
    await client.query(`UPDATE notes SET visibility = 'ORGANISATION' WHERE id = $1`, [id]);
  });

  it("the job_runs table exists for the heartbeat", async () => {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM job_runs`);
    expect(rows[0].n).toBeGreaterThanOrEqual(0);
  });
});
