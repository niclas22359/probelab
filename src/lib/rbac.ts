import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { resolvePersonAccess } from "@/lib/platform-client/core/decide";
import type { AccessDenyReason, DoorState } from "@/lib/platform-client/core/types";
import { getAuthToken, getSession, type PlatformSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { getLabGate, type LabGate } from "@/lib/platform-access";
import { door, platformUrl } from "@/lib/platform/door";
import {
  PRODUCT,
  UNGOVERNED,
  accessClient,
  hasProductAccess,
  isProductAdmin,
  type AccessContext,
} from "@/lib/platform/access";

/**
 * Tenant guard AND access — the only place where an organisation is
 * determined. The whole service layer takes `organisationId` as a MANDATORY
 * argument and filters every query by it, plus the container filter from
 * `src/lib/access-rules.ts`.
 *
 * THREE levels, never to be confused:
 *  1. Is this Lab released for this account at all? — the SUITE (`getLabGate`).
 *  2. May this person use this Lab? — the PLATFORM (`productRole`, `governed`).
 *  3. What does she see and change in it? — the CONTAINER on the single row,
 *     together with collections and individual grants from the platform.
 *
 * Levels 1 and 2 are decided by the shared decision of
 * beyondles-ai/beyondles-shared (`core/decide.ts` `resolvePersonAccess`):
 * token, gate, door, platform, in that order. Level 1 wins in every door
 * state; with the door `unconfigured` or `off` nobody gets a context (policy
 * P1); the local context exists only in the door state `local`.
 */

export interface OrgContext {
  session: PlatformSession;
  organisationId: string;
  gate: LabGate;
  /** `null` always and only means NO access. */
  access: AccessContext | null;
  token: string | null;
  /** Why `access` is `null`; `null` when access was granted. */
  denied: AccessDenyReason | null;
  /** The door state the decision was taken in. */
  doorState: DoorState;
}

export interface AccessGrantedContext extends OrgContext {
  access: AccessContext;
  isAdmin: boolean;
}

const NO_GATE: LabGate = { allowed: false, reason: "blocked", lab: null };

function loginUrl(): string {
  return `${platformUrl() ?? "https://beyondles.ai"}/login`;
}

/** The signed-in session, or a redirect to the Suite login. */
export async function requireSession(): Promise<PlatformSession> {
  const session = await getSession();
  if (!session) redirect(loginUrl());
  return session;
}

/**
 * Session + gate + platform context, without deciding where to send anybody.
 * `fresh` asks the platform past its 60 s cache: for an action that mints a
 * credential (an API key), so a key is never minted from a session whose
 * token the platform already refuses (HOST-CONTRACT section 4).
 */
async function loadOrg(fresh: boolean): Promise<OrgContext> {
  const session = await requireSession();
  const token = (await getAuthToken())?.trim() || null;
  const state = door();

  const outcome = await resolvePersonAccess({
    token,
    session,
    door: state,
    me: (value) => (fresh ? accessClient.me(value, { fresh: true }) : accessClient.me(value)),
    gate: getLabGate,
    ungoverned: UNGOVERNED,
    product: PRODUCT,
  });

  const base = {
    session,
    organisationId: session.organisationId,
    gate: outcome.gate ?? { ...NO_GATE },
    token,
    doorState: outcome.doorState,
  };
  if (!outcome.ok) return { ...base, access: null, denied: outcome.reason };

  // The organisation of the signed-in TOKEN is the truth for every query. A
  // platform answer for another organisation is never acted upon.
  if (outcome.access.organisationId.toLowerCase() !== session.organisationId.toLowerCase()) {
    console.error("[rbac] platform answered /api/access/me with a different organisation than the session token — refusing.");
    return { ...base, access: null, denied: "unavailable" };
  }
  return { ...base, access: { ...outcome.access, organisationId: session.organisationId }, denied: null };
}

/** Session + gate + platform context, without deciding. Cached per request. */
export const requireOrg = cache(async (): Promise<OrgContext> => loadOrg(false));

function granted(ctx: OrgContext): ctx is OrgContext & { access: AccessContext } {
  return ctx.gate.allowed && ctx.access !== null && hasProductAccess(ctx.access);
}

/**
 * The entry for every page and action of the signed-in area: redirects
 * without a session, sends people without access to the notice page, and
 * creates the organisation mirror on the very first visit.
 */
export async function requireAccess(): Promise<AccessGrantedContext> {
  const ctx = await requireOrg();
  if (!granted(ctx)) redirect("/kein-zugriff");
  await ensureOrganisation(ctx.session);
  return { ...ctx, access: ctx.access, isAdmin: isProductAdmin(ctx.access) };
}

/** Like requireAccess, but `null` instead of a redirect (for actions). */
export async function requireAccessOrNull(): Promise<AccessGrantedContext | null> {
  const ctx = await requireOrg();
  if (!granted(ctx)) return null;
  await ensureOrganisation(ctx.session);
  return { ...ctx, access: ctx.access, isAdmin: isProductAdmin(ctx.access) };
}

/**
 * Like requireAccessOrNull, but the platform is asked NOW, not from its 60 s
 * cache. For actions that mint a credential (creating an API key).
 */
export async function requireFreshAccessOrNull(): Promise<AccessGrantedContext | null> {
  const ctx = await loadOrg(true);
  if (!granted(ctx)) return null;
  await ensureOrganisation(ctx.session);
  return { ...ctx, access: ctx.access, isAdmin: isProductAdmin(ctx.access) };
}

/** Mirror row of the Suite organisation; name and slug follow the Suite. */
export async function ensureOrganisation(session: PlatformSession): Promise<void> {
  await db.organisation.upsert({
    where: { id: session.organisationId },
    create: {
      id: session.organisationId,
      slug: session.organisationSlug,
      name: session.organisationSlug,
    },
    update: { slug: session.organisationSlug, name: session.organisationSlug },
  });
}

/**
 * Mirror row for a caller WITHOUT a Suite session: an on-behalf token names
 * only the organisation id. Created with id = slug = name; an existing row is
 * left alone, and a later Suite sign-in overwrites slug and name as above.
 */
export async function ensureOrganisationById(organisationId: string): Promise<void> {
  await db.organisation.upsert({
    where: { id: organisationId },
    create: { id: organisationId, slug: organisationId, name: organisationId },
    update: {},
  });
}
