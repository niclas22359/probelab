'use client';

/**
 * One button, one dialog, the same in every product.
 *
 * The dialog owns no knowledge of where the data lives: the product hands in a
 * `load()` and a `save(patch)` and gets back exactly one save call carrying the
 * difference between what was loaded and what the person left behind. That is
 * what makes the folder copyable — a Lab wires the same two functions to its own
 * routes and the dialog behaves identically.
 *
 * The read-only branch (`canManage: false`) is not a disabled version of the
 * editable one: it shows who has access and nothing that looks clickable, because
 * a greyed-out control invites a person to keep clicking it. Its default button
 * is labelled accordingly ("Wer hat Zugriff", not "Teilen").
 */

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
// React 19 removed the global `JSX` namespace; the type comes from 'react'
// instead, which the React 18.3 types export as well. A type-only import, so
// the same file compiles in every product.
import type { JSX } from 'react';
import { Users, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/share-primitives/Button';
import { Card } from '@/components/ui/share-primitives/Card';
import { PeoplePicker } from './PeoplePicker';
import { VisibilityBadge } from './VisibilityBadge';
import { VisibilityPicker } from './VisibilityPicker';
import { buildSharePatch, type ShareDraft, type SharePatch, type ShareState } from './share-patch';
import type { Person, Visibility } from './types';

// The data shapes and `buildSharePatch` live in the pure module `share-patch.ts`.
// The types are re-exported here so an import from this file keeps compiling;
// the function is not, because this is a client module.
export type { ShareDraft, SharePatch, ShareState } from './share-patch';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ShareDialogProps {
  objectTitle: string;
  /** false → read-only view of who has access */
  canManage: boolean;
  load(): Promise<ShareState>;
  save(patch: SharePatch): Promise<void>;
  /**
   * default: a button with the Users icon. It says "Teilen" for a person who
   * may manage the sharing and "Wer hat Zugriff" for one who may only look.
   * A trigger passed here always wins.
   */
  trigger?: ReactNode;
}

export function ShareDialog({
  objectTitle,
  canManage,
  load,
  save,
  trigger,
}: ShareDialogProps): JSX.Element {
  const t = useTranslations('share');

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [state, setState] = useState<ShareState | null>(null);
  const [initial, setInitial] = useState<ShareDraft | null>(null);
  const [draft, setDraft] = useState<ShareDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [discardPrompt, setDiscardPrompt] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const backdropArmed = useRef(false);

  /**
   * `loading` is raised here and not only in the load effect. The render caused
   * by `setOpen(true)` commits before any effect runs, so leaving it to the
   * effect would show one frame of an empty dialog body before "Wird geladen …"
   * appears.
   */
  const openDialog = useCallback(() => {
    setLoading(true);
    setOpen(true);
  }, []);

  /**
   * Closing throws the whole draft away, so it throws away every trace of it.
   * Keeping `state`/`draft` around would make the next open paint one frame of
   * the discarded draft: the open-render commits before the load effect can put
   * the dialog back into its loading branch.
   */
  const closeDialog = useCallback(() => {
    setOpen(false);
    setDiscardPrompt(false);
    setState(null);
    setInitial(null);
    setDraft(null);
    setSaveError(null);
    setLoadFailed(false);
  }, []);

  // The product may pass fresh closures on every render. Keeping them in refs
  // means the load effect depends on `open` alone and never re-fires in a loop.
  const loadRef = useRef(load);
  const saveRef = useRef(save);
  // The same trick for the Esc handler: its effect depends on `open` alone, so it
  // must not close over a `hasChanges` from the render that installed it.
  const requestCloseRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    loadRef.current = load;
    saveRef.current = save;
  });

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;

    setLoading(true);
    setLoadFailed(false);
    setSaveError(null);

    loadRef
      .current()
      .then((loaded) => {
        if (cancelled) return;
        const next: ShareDraft = {
          visibility: loaded.visibility,
          collectionId: loaded.collectionId,
          people: loaded.people,
        };
        setState(loaded);
        setInitial(next);
        setDraft(next);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadFailed(true);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const patch = initial && draft ? buildSharePatch(initial, draft) : {};
  const hasChanges = Object.keys(patch).length > 0;

  /**
   * The two easy exits — Esc and the backdrop — must not silently bin work. With
   * nothing changed they close at once; with unsaved edits they ask first. The
   * explicit "Abbrechen" button says what it does and closes without asking.
   */
  function requestClose(): void {
    if (discardPrompt) {
      setDiscardPrompt(false);
      return;
    }
    if (canManage && hasChanges && !saving) {
      setDiscardPrompt(true);
      return;
    }
    closeDialog();
  }

  useEffect(() => {
    requestCloseRef.current = requestClose;
  });

  // Esc closes, Tab stays inside, and the focus goes back where it came from.
  useEffect(() => {
    if (!open) return undefined;
    const node = dialogRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    node?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !node) return;

      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first || active === node || !node.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last || !node.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  async function handleSave(): Promise<void> {
    if (!hasChanges || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveRef.current(patch);
      setSaving(false);
      closeDialog();
    } catch (error) {
      setSaving(false);
      setSaveError(error instanceof Error && error.message ? error.message : '');
    }
  }

  function onVisibilityChange(next: { visibility: Visibility; collectionId?: string | null }): void {
    setDraft((current) =>
      current
        ? { ...current, visibility: next.visibility, collectionId: next.collectionId ?? null }
        : current
    );
  }

  function onAddPerson(person: Person, level?: 'view' | 'edit'): void {
    setDraft((current) => {
      if (!current || current.people.some((p) => p.userId === person.userId)) return current;
      return { ...current, people: [...current.people, { ...person, level: level ?? 'view' }] };
    });
  }

  function onRemovePerson(userId: string): void {
    setDraft((current) =>
      current ? { ...current, people: current.people.filter((p) => p.userId !== userId) } : current
    );
  }

  function onLevelChange(userId: string, level: 'view' | 'edit'): void {
    setDraft((current) =>
      current
        ? {
            ...current,
            people: current.people.map((p) => (p.userId === userId ? { ...p, level } : p)),
          }
        : current
    );
  }

  type TriggerProps = { onClick?: (event: ReactMouseEvent<HTMLElement>) => void };

  const triggerNode = trigger ? (
    isValidElement(trigger) ? (
      // Compose, never replace: a product's trigger may carry its own handler
      // (analytics, closing the menu it sits in) and must keep it.
      cloneElement(trigger as ReactElement<TriggerProps>, {
        onClick: (event: ReactMouseEvent<HTMLElement>) => {
          (trigger as ReactElement<TriggerProps>).props.onClick?.(event);
          openDialog();
        },
      })
    ) : (
      <button
        type="button"
        onClick={openDialog}
        className="inline-flex items-center gap-2 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {trigger}
      </button>
    )
  ) : (
    // "Teilen" on a dialog that lets the person share nothing would be a
    // promise the next click takes back. Without the right to manage, the
    // button says what really happens: it shows who has access.
    <Button type="button" variant="secondary" size="sm" onClick={openDialog}>
      <Users className="h-4 w-4" aria-hidden="true" />
      {canManage ? t('dialog.trigger') : t('dialog.viewTrigger')}
    </Button>
  );

  return (
    <>
      {triggerNode}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          // A click, not a mousedown, and only one that both started and ended on
          // the backdrop: selecting text inside the dialog and releasing outside
          // it must not count as "close this".
          onMouseDown={(event) => {
            backdropArmed.current = event.target === event.currentTarget;
          }}
          onClick={(event) => {
            if (event.target !== event.currentTarget || !backdropArmed.current) return;
            backdropArmed.current = false;
            requestClose();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="w-full max-w-lg outline-none"
          >
            <Card
              variant="elevated"
              padding="none"
              className="max-h-[85vh] overflow-y-auto bg-white p-5 sm:p-6"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 id={titleId} className="text-base font-semibold text-content-primary">
                    {t('dialog.title', { title: objectTitle })}
                  </h2>
                  {state && (
                    <p className="mt-1 text-xs text-content-tertiary">
                      {t('dialog.ownedBy', { name: state.owner.name })}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={t('dialog.close')}
                  onClick={requestClose}
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-content-tertiary transition-colors hover:bg-surface-secondary hover:text-content-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>

              {/* Announced politely, so a screen reader hears the dialog fill in
                  instead of being left on a silent panel after load() resolves. */}
              <div className="mt-5 space-y-4" aria-live="polite" aria-busy={loading}>
                {loading && <p className="text-sm text-content-secondary">{t('dialog.loading')}</p>}

                {loadFailed && (
                  <p role="alert" className="text-sm text-red-600">
                    {t('dialog.loadError')}
                  </p>
                )}

                {!loading && !loadFailed && state && draft && (
                  <>
                    {canManage ? (
                      <>
                        <VisibilityPicker
                          value={{ visibility: draft.visibility, collectionId: draft.collectionId }}
                          onChange={onVisibilityChange}
                          collections={state.collections}
                          personalAllowed={state.personalAllowed}
                          membersMayShareOrg={state.membersMayShareOrg}
                          isOrgAdmin={state.isOrgAdmin}
                          disabled={saving}
                        />

                        <div className="border-t border-black/5 pt-4">
                          <p className="mb-3 text-sm font-medium text-content-secondary">
                            {t('dialog.peopleHeading')}
                          </p>
                          <PeoplePicker
                            members={state.members}
                            selected={draft.people}
                            onAdd={onAddPerson}
                            onRemove={onRemovePerson}
                            onLevelChange={onLevelChange}
                            excludeUserIds={[state.owner.userId]}
                            disabled={saving}
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <VisibilityBadge
                            visibility={state.visibility}
                            collectionName={
                              state.collections.find((c) => c.id === state.collectionId)?.name ?? null
                            }
                            size="md"
                          />
                        </div>
                        <p className="text-xs text-content-tertiary">{t('dialog.readOnlyNote')}</p>

                        <div className="border-t border-black/5 pt-4">
                          <p className="mb-3 text-sm font-medium text-content-secondary">
                            {t('dialog.peopleHeading')}
                          </p>
                          {state.people.length === 0 ? (
                            <p className="text-xs text-content-tertiary">{t('people.empty')}</p>
                          ) : (
                            <ul className="space-y-2">
                              {state.people.map((person) => (
                                <li
                                  key={person.userId}
                                  className="flex items-center justify-between gap-2 rounded-lg border border-black/5 bg-surface-secondary px-3 py-2"
                                >
                                  <span className="min-w-0">
                                    <span className="block truncate text-sm text-content-primary">
                                      {person.name}
                                    </span>
                                    <span className="block truncate text-xs text-content-tertiary">
                                      {person.email}
                                    </span>
                                  </span>
                                  <span className="flex-shrink-0 text-xs text-content-secondary">
                                    {person.level === 'edit'
                                      ? t('people.levelEdit')
                                      : t('people.levelView')}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </>
                    )}

                    {state.usesPersonalConnections && state.usesPersonalConnections.length > 0 && (
                      <p className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        {t('dialog.personalConnections', {
                          labels: state.usesPersonalConnections.join(', '),
                        })}
                      </p>
                    )}

                    {saveError !== null && (
                      <div role="alert" className="text-xs text-red-600">
                        <p>{t('dialog.saveError')}</p>
                        {saveError ? <p className="mt-1 opacity-80">{saveError}</p> : null}
                      </div>
                    )}
                  </>
                )}
              </div>

              {discardPrompt && (
                <div
                  role="status"
                  className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
                >
                  <p>{t('dialog.discardQuestion')}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setDiscardPrompt(false)}
                    >
                      {t('dialog.discardKeep')}
                    </Button>
                    <Button type="button" variant="danger" size="sm" onClick={closeDialog}>
                      {t('dialog.discardConfirm')}
                    </Button>
                  </div>
                </div>
              )}

              <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                {canManage && !loadFailed ? (
                  <>
                    <Button
                      type="button"
                      variant="secondary"
                      className="min-h-[44px]"
                      onClick={closeDialog}
                      disabled={saving}
                    >
                      {t('dialog.cancel')}
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      className="min-h-[44px]"
                      onClick={() => void handleSave()}
                      disabled={!hasChanges || saving}
                      isLoading={saving}
                    >
                      {t('dialog.save')}
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    className="min-h-[44px]"
                    onClick={closeDialog}
                  >
                    {t('dialog.closeButton')}
                  </Button>
                )}
              </div>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
