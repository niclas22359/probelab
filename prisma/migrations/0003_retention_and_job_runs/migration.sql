-- Retention (lab learnings, Masoud 30.09.2026): a redacted row stays redacted.
ALTER TABLE "notes" ADD COLUMN "redactedAt" TIMESTAMP(3);

-- A redaction that cannot be written back. A retry, a stale form or a buggy
-- import that UPDATEs a redacted row with its old personal values is refused
-- by the database itself, whatever the application code does.
CREATE OR REPLACE FUNCTION notes_keep_redaction() RETURNS trigger AS $$
BEGIN
  IF OLD."redactedAt" IS NOT NULL THEN
    IF NEW."redactedAt" IS NULL
       OR NEW."title" IS DISTINCT FROM OLD."title"
       OR NEW."body" IS DISTINCT FROM OLD."body" THEN
      RAISE EXCEPTION 'note % is redacted; personal columns cannot be written back', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notes_keep_redaction
  BEFORE UPDATE ON "notes"
  FOR EACH ROW EXECUTE FUNCTION notes_keep_redaction();

-- Heartbeat state of the scheduled jobs.
CREATE TABLE "job_runs" (
    "name" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "lastStatus" TEXT NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("name")
);
