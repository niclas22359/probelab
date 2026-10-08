# Building a Lab from this template — the guide for people

Checked on: 2026-10-08

This is the path from "I want a Lab" to "my Lab is live in the Beyondles
Suite", for anyone outside Beyondles who builds one. Beyondles developers use
the same template with the internal pipeline (`/lab-pipeline`); the repo
side is identical.

## 0. What you are building

A Lab is a web tool that lives inside the Beyondles ecosystem. Your users sign
in through the Beyondles Suite, the Lab appears as a tile in the Suite's
Toolbox, AI and mail go through the Beyondles platform (no provider keys in
your code), and every function of your Lab is available to Beyondles HorAIzon
agents as a tool. All of that is already wired in this template. You build the
product: your data, your screens, your functions. `docs/FRAME.md` says what
the frame guarantees and what it expects of you.

Two things to accept before the first commit (the Suite asks you to tick them
when you request a Lab):

1. Beyondles hosts and operates accepted Labs and holds the right to run the
   code; you keep the right to reuse your own contribution.
2. The Lab must pass the automated checks of this template and a review by
   Beyondles before it is accepted. A Lab that leaves the frame is not
   accepted.

## 1. Create your repository

In the Beyondles Suite, open the Toolbox and choose **Build your own Lab**.
The page gives you the link to this template. On GitHub, use
**Use this template → Create a new repository** in your own account or
organisation; private is fine. Then:

```bash
git clone <your repo>
cd <your repo>
npm run rename -- <name> "<Display Name>"     # e.g. invoicelab "InvoiceLab"
npm ci
npm run check:frame && npm test
```

`<name>` is one word, lower-case letters, ending in `lab`. It becomes the
subdomain, the Suite tile key and the platform product key, so choose it
once. The rename prints the few places only you can decide (ports, the one
sentence in `README.md`, the example object).

Your GitHub Actions run in your account at your cost. The checks they run
are the same ones Beyondles runs on acceptance.

## 2. Build

Work with Claude Code or any AI coding agent: `CLAUDE.md` and `AGENTS.md`
tell it what to touch and what never to touch. Without an agent, follow the
recipe in `CLAUDE.md`, section 3, for every function.

Run locally without any Beyondles system: `.env` with `JWT_SECRET=<anything>`
and `ALLOW_LOCAL_JWT=true`, a local Postgres, `npm run db:migrate`,
`npm run dev`, then `node scripts/dev-login.mjs` for a sign-in cookie
(`README.md`, "Run locally"). The platform door is off locally; AI and mail
calls answer "door not configured" until Beyondles provides keys on staging.

Keep these green at every step: `npm run check:frame`, `npm test`,
`npm run build`. Every message names the rule and the file.

## 3. Before you submit

- Replace the example object `Note` with your own objects, or delete it.
- Fill `docs/HANDOVER.md` completely. The **Not tested** section is read
  first by the reviewer.
- Agree retention periods for every table with personal data with the
  people whose data it is, and put them into `src/server/retention/registry.ts`.
- Make sure the repository contains no secret, no customer data and no
  password (also not in `docs/`).
- Tag the commit you submit (`git tag submit-1`).

## 4. Submit

Back in the Suite, on **Build your own Lab**, press **Submit a Lab** and
enter: the repository address, the tag, the Lab name, the one sentence, and
answer the four questions (mail? files? background jobs? personal data or a
legal peculiarity?). Tick the second agreement (hosting, review, data
protection). Beyondles needs **read access** to your repository: add the
GitHub user named on that page as a collaborator with read permission, or
make the repository public.

What happens then, and what you see on the same page:

1. **Received.** Beyondles clones the tag into its own organisation
   (`beyondles-ai/<name>`), runs the checks and the tests on its own CI.
2. **In review.** A Beyondles developer reviews the code against the frame
   checklist. Findings come back to you as a list; you fix them in your
   repository and submit a new tag.
3. **On staging.** The Lab runs at `https://<name>-staging.beyondles.ai`
   behind the Beyondles team login. You get two test accounts and try it
   with real data.
4. **Accepted.** Release to production, Suite tile, platform registration,
   HorAIzon tool registration. Beyondles switches the Lab on for your
   organisation.

From "Received" to "Accepted" the copy in `beyondles-ai/<name>` is the one
that is reviewed and deployed. Further changes go the same way: a new tag in
your repository, a new submission. Beyondles never pushes into your
repository and you never push into Beyondles'.

## 5. What Beyondles decides, not the template

- Whether the Lab is accepted at all (purpose, overlap with existing Labs,
  legal fit).
- Hosting costs and the price of the Lab for its users.
- Secrets, keys, domains, tunnels, server accounts.
- The release click to production.
