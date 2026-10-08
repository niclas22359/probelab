-- Scopes on API keys (headless by construction, 06.10.2026).
-- Existing keys keep FULL access ('*', filled in by the column default of the
-- first statement) so nothing that works today breaks; their owners narrow
-- them later by creating a new key and revoking the old one.
-- New keys get read only (the second statement; the same default Prisma
-- generates for `scopes String[] @default(["read"])`).
ALTER TABLE "api_keys" ADD COLUMN "scopes" TEXT[] DEFAULT ARRAY['*']::TEXT[];
ALTER TABLE "api_keys" ALTER COLUMN "scopes" SET DEFAULT ARRAY['read']::TEXT[];
