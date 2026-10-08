/**
 * The two functions the share dialog needs, wired to a product's own share
 * route: `GET|PUT <baseUrl>/<type>/<id>`.
 *
 * Six products wrote this adapter by hand, each a little differently. It is
 * optional: a product whose share data does not live behind such a route (server
 * actions, another API client) keeps passing its own `load` and `save` to
 * `ShareDialog`.
 *
 * No `'use client'` and no state: the object only builds URLs and calls `fetch`.
 * What happens after a save (refresh, reload, a notice) stays with the product.
 *
 *   const share = createShareEndpoint('/api/share');
 *   <ShareDialog
 *     load={() => share.load('lead', id)}
 *     save={(patch) => share.save('lead', id, patch)}
 *     …
 *   />
 */

import type { SharePatch, ShareState } from './share-patch';

export interface ShareEndpoint {
  /**
   * Throws on every answer that is not 2xx. The dialog then says that the
   * sharing settings could not be loaded. An empty list would be the dangerous
   * answer here: it would read as "nobody has access".
   */
  load(type: string, id: string): Promise<ShareState>;
  /**
   * Throws on every answer that is not 2xx, with the route's own
   * `error.message` when the body carries one, so the dialog can show why a
   * forbidden visibility was refused. Otherwise the message is `HTTP <status>`.
   */
  save(type: string, id: string, patch: SharePatch): Promise<void>;
}

export function createShareEndpoint(baseUrl: string): ShareEndpoint {
  const base = baseUrl.replace(/\/+$/, '');

  function url(type: string, id: string): string {
    return `${base}/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
  }

  return {
    async load(type, id) {
      const response = await fetch(url(type, id), {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return (await response.json()) as ShareState;
    },

    async save(type, id, patch) {
      const response = await fetch(url(type, id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(patch),
      });
      if (response.ok) return;

      let message = `HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: { message?: unknown } } | null;
        const fromRoute = body?.error?.message;
        if (typeof fromRoute === 'string' && fromRoute !== '') message = fromRoute;
      } catch {
        // Not JSON. The status code stays the only information there is.
      }
      throw new Error(message);
    },
  };
}
