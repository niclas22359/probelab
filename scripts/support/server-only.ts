/**
 * Stand-in for the `server-only` marker when a job or check runs outside
 * Next.js (tsx, scripts/tsconfig.json maps the import here). The marker only
 * guards against bundling server code into the browser; a script IS server.
 */
export {};
