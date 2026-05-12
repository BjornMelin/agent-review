'use client';

import type {
  ReviewFinding,
  ReviewFindingTriageRecord,
  ReviewFindingTriageStatus,
  ReviewPublicationRecord,
} from '@review-agent/review-types';
import {
  CheckCircle2,
  Filter,
  Loader2,
  MessageSquareText,
  Save,
} from 'lucide-react';
import type { Route } from 'next';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const TRIAGE_STATUSES: ReviewFindingTriageStatus[] = [
  'open',
  'accepted',
  'false-positive',
  'fixed',
  'published',
  'dismissed',
  'ignored',
];

type PublicationFilter =
  | 'all'
  | 'published'
  | 'failed'
  | 'skipped'
  | 'unsupported'
  | 'unpublished';

type TriageFilters = {
  priority: string;
  provider: string;
  state: string;
  reviewer: string;
  publication: PublicationFilter;
  path: string;
};

type FindingWorkspaceProps = {
  findings: ReviewFinding[];
  publications: ReviewPublicationRecord[];
  provider: string | undefined;
  reviewId: string;
  triage: ReviewFindingTriageRecord[];
};

type SearchParamsLike = Pick<URLSearchParams, 'get' | 'toString'>;
type TriageFilterUpdate =
  | TriageFilters
  | ((current: TriageFilters) => TriageFilters);

const DEFAULT_TRIAGE_FILTERS: TriageFilters = {
  priority: 'all',
  provider: 'all',
  state: 'all',
  reviewer: 'all',
  publication: 'all',
  path: '',
};

const TRIAGE_FILTER_PARAM_KEYS = {
  priority: 'triagePriority',
  provider: 'triageProvider',
  state: 'triageState',
  reviewer: 'triageReviewer',
  publication: 'triagePublication',
  path: 'triagePath',
} as const;

const PRIORITY_FILTER_VALUES = new Set(['all', '0', '1', '2', '3', '?']);
const PUBLICATION_FILTER_VALUES = new Set<PublicationFilter>([
  'all',
  'published',
  'failed',
  'skipped',
  'unsupported',
  'unpublished',
]);
const STATE_FILTER_VALUES = new Set<string>(['all', ...TRIAGE_STATUSES]);
const EMPTY_PENDING = new Set<string>();

function enumFilterParam(
  params: SearchParamsLike,
  key: string,
  allowed: ReadonlySet<string>,
  fallback: string
): string {
  const value = params.get(key);
  return value && allowed.has(value) ? value : fallback;
}

function textFilterParam(
  params: SearchParamsLike,
  key: string,
  fallback: string
): string {
  const value = params.get(key);
  return value?.trim() ? value : fallback;
}

function parseTriageFilters(params: SearchParamsLike): TriageFilters {
  return {
    priority: enumFilterParam(
      params,
      TRIAGE_FILTER_PARAM_KEYS.priority,
      PRIORITY_FILTER_VALUES,
      DEFAULT_TRIAGE_FILTERS.priority
    ),
    provider: textFilterParam(
      params,
      TRIAGE_FILTER_PARAM_KEYS.provider,
      DEFAULT_TRIAGE_FILTERS.provider
    ),
    state: enumFilterParam(
      params,
      TRIAGE_FILTER_PARAM_KEYS.state,
      STATE_FILTER_VALUES,
      DEFAULT_TRIAGE_FILTERS.state
    ),
    reviewer: textFilterParam(
      params,
      TRIAGE_FILTER_PARAM_KEYS.reviewer,
      DEFAULT_TRIAGE_FILTERS.reviewer
    ),
    publication: enumFilterParam(
      params,
      TRIAGE_FILTER_PARAM_KEYS.publication,
      PUBLICATION_FILTER_VALUES,
      DEFAULT_TRIAGE_FILTERS.publication
    ) as PublicationFilter,
    path:
      params.get(TRIAGE_FILTER_PARAM_KEYS.path) ?? DEFAULT_TRIAGE_FILTERS.path,
  };
}

function writeTriageFilterParam(
  params: URLSearchParams,
  key: string,
  value: string,
  defaultValue: string
): void {
  if (value === defaultValue || value.length === 0) {
    params.delete(key);
    return;
  }
  params.set(key, value);
}

function triageFiltersHref(
  pathname: string,
  searchParams: SearchParamsLike,
  filters: TriageFilters
): string {
  const params = new URLSearchParams(searchParams.toString());
  writeTriageFilterParam(
    params,
    TRIAGE_FILTER_PARAM_KEYS.priority,
    filters.priority,
    DEFAULT_TRIAGE_FILTERS.priority
  );
  writeTriageFilterParam(
    params,
    TRIAGE_FILTER_PARAM_KEYS.provider,
    filters.provider,
    DEFAULT_TRIAGE_FILTERS.provider
  );
  writeTriageFilterParam(
    params,
    TRIAGE_FILTER_PARAM_KEYS.state,
    filters.state,
    DEFAULT_TRIAGE_FILTERS.state
  );
  writeTriageFilterParam(
    params,
    TRIAGE_FILTER_PARAM_KEYS.reviewer,
    filters.reviewer,
    DEFAULT_TRIAGE_FILTERS.reviewer
  );
  writeTriageFilterParam(
    params,
    TRIAGE_FILTER_PARAM_KEYS.publication,
    filters.publication,
    DEFAULT_TRIAGE_FILTERS.publication
  );
  writeTriageFilterParam(
    params,
    TRIAGE_FILTER_PARAM_KEYS.path,
    filters.path,
    DEFAULT_TRIAGE_FILTERS.path
  );
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function priorityLabel(priority: ReviewFinding['priority']): string {
  if (priority === undefined) {
    return 'P?';
  }
  return `P${priority}`;
}

function fileLabel(path: string): string {
  const segments = path.split('/');
  return segments.slice(-2).join('/');
}

function publicationStatusMap(
  publications: ReviewPublicationRecord[]
): Map<string, PublicationFilter> {
  const statuses = new Map<string, PublicationFilter>();
  for (const record of publications) {
    const metadata = record.metadata as { fingerprint?: unknown } | undefined;
    if (
      record.channel === 'pullRequestComment' &&
      typeof metadata?.fingerprint === 'string' &&
      !statuses.has(metadata.fingerprint)
    ) {
      statuses.set(metadata.fingerprint, record.status);
    }
  }
  return statuses;
}

function publicationStatusFor(
  publications: Map<string, PublicationFilter>,
  finding: ReviewFinding
): PublicationFilter {
  return publications.get(finding.fingerprint) ?? 'unpublished';
}

function triageRecordMap(
  records: ReviewFindingTriageRecord[]
): Map<string, ReviewFindingTriageRecord> {
  return new Map(records.map((record) => [record.fingerprint, record]));
}

function draftNotesFromRecords(
  records: Iterable<ReviewFindingTriageRecord>
): Record<string, string> {
  return Object.fromEntries(
    [...records].map((record) => [record.fingerprint, record.note ?? ''])
  );
}

function statusVariant(
  status: ReviewFindingTriageStatus
): React.ComponentProps<typeof Badge>['variant'] {
  if (status === 'accepted' || status === 'published' || status === 'fixed') {
    return 'success';
  }
  if (status === 'false-positive' || status === 'dismissed') {
    return 'warning';
  }
  if (status === 'ignored') {
    return 'neutral';
  }
  return 'info';
}

function publicationVariant(
  status: PublicationFilter
): React.ComponentProps<typeof Badge>['variant'] {
  if (status === 'published') {
    return 'success';
  }
  if (status === 'failed') {
    return 'danger';
  }
  if (status === 'unpublished') {
    return 'neutral';
  }
  return 'warning';
}

/**
 * Renders filterable findings with reviewer-owned triage state and notes.
 *
 * @param props - Findings, publication records, provider label, review ID, and triage records.
 * @returns Review Room finding triage workspace UI.
 */
export function FindingWorkspace(
  props: FindingWorkspaceProps
): React.ReactNode {
  const { findings, publications, provider, reviewId, triage } = props;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamString = searchParams.toString();
  const incomingRecords = useMemo(() => triageRecordMap(triage), [triage]);
  const incomingDraftNotes = useMemo(
    () => draftNotesFromRecords(incomingRecords.values()),
    [incomingRecords]
  );
  const [stateScope, setStateScope] = useState(reviewId);
  const [records, setRecords] = useState(() => incomingRecords);
  const [draftNotes, setDraftNotes] = useState<Record<string, string>>({});
  const dirtyNotesRef = useRef(new Set<string>());
  const reviewScopeRef = useRef(reviewId);
  const pendingRef = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [filters, setFiltersState] = useState<TriageFilters>(() =>
    parseTriageFilters(searchParams)
  );
  const filtersRef = useRef(filters);
  const recordsForReview = stateScope === reviewId ? records : incomingRecords;
  const draftNotesForReview =
    stateScope === reviewId ? draftNotes : incomingDraftNotes;
  const pendingForReview = stateScope === reviewId ? pending : EMPTY_PENDING;

  useEffect(() => {
    if (reviewScopeRef.current !== reviewId) {
      reviewScopeRef.current = reviewId;
      dirtyNotesRef.current.clear();
      pendingRef.current.clear();
      setStateScope(reviewId);
      setRecords(incomingRecords);
      setDraftNotes(incomingDraftNotes);
      setPending(new Set());
      setError(null);
      return;
    }

    setRecords(incomingRecords);
    setDraftNotes((current) => {
      const merged = { ...current };
      for (const record of incomingRecords.values()) {
        if (
          !dirtyNotesRef.current.has(record.fingerprint) &&
          !pendingRef.current.has(record.fingerprint)
        ) {
          merged[record.fingerprint] = record.note ?? '';
        } else if (!(record.fingerprint in merged)) {
          merged[record.fingerprint] = record.note ?? '';
        }
      }
      for (const fingerprint of Object.keys(merged)) {
        if (
          !incomingRecords.has(fingerprint) &&
          !dirtyNotesRef.current.has(fingerprint)
        ) {
          delete merged[fingerprint];
        }
      }
      return merged;
    });
  }, [incomingDraftNotes, incomingRecords, reviewId]);

  useEffect(() => {
    const next = parseTriageFilters(new URLSearchParams(searchParamString));
    filtersRef.current = next;
    setFiltersState(next);
  }, [searchParamString]);

  const setFilters = useCallback(
    (update: TriageFilterUpdate) => {
      const next =
        typeof update === 'function' ? update(filtersRef.current) : update;
      filtersRef.current = next;
      setFiltersState(next);
      const nextHref = triageFiltersHref(
        pathname,
        new URLSearchParams(searchParamString),
        next
      );
      const currentHref = searchParamString
        ? `${pathname}?${searchParamString}`
        : pathname;
      if (nextHref !== currentHref) {
        router.replace(nextHref as Route, { scroll: false });
      }
    },
    [pathname, router, searchParamString]
  );

  const reviewers = useMemo(() => {
    return [
      ...new Set(
        [...recordsForReview.values()].flatMap((record) => record.actor ?? [])
      ),
    ]
      .filter(Boolean)
      .sort();
  }, [recordsForReview]);
  const publicationStatuses = useMemo(
    () => publicationStatusMap(publications),
    [publications]
  );

  const visibleFindings = useMemo(() => {
    const normalizedPath = filters.path.trim().toLowerCase();
    return findings.filter((finding) => {
      const record = recordsForReview.get(finding.fingerprint);
      const status = record?.status ?? 'open';
      const actor = record?.actor ?? 'unassigned';
      const publication = publicationStatusFor(publicationStatuses, finding);
      if (
        filters.priority !== 'all' &&
        String(finding.priority ?? '?') !== filters.priority
      ) {
        return false;
      }
      if (filters.provider !== 'all' && filters.provider !== provider) {
        return false;
      }
      if (filters.state !== 'all' && status !== filters.state) {
        return false;
      }
      if (filters.reviewer !== 'all' && actor !== filters.reviewer) {
        return false;
      }
      if (
        filters.publication !== 'all' &&
        publication !== filters.publication
      ) {
        return false;
      }
      if (
        normalizedPath &&
        !finding.codeLocation.absoluteFilePath
          .toLowerCase()
          .includes(normalizedPath)
      ) {
        return false;
      }
      return true;
    });
  }, [filters, findings, provider, publicationStatuses, recordsForReview]);

  const setFindingPending = useCallback(
    (fingerprint: string, nextPending: boolean) => {
      if (nextPending) {
        pendingRef.current.add(fingerprint);
      } else {
        pendingRef.current.delete(fingerprint);
      }
      setPending(new Set(pendingRef.current));
    },
    []
  );

  async function saveTriage(
    finding: ReviewFinding,
    status: ReviewFindingTriageStatus
  ): Promise<void> {
    if (pendingRef.current.has(finding.fingerprint)) {
      return;
    }
    const previous = recordsForReview.get(finding.fingerprint);
    const note = draftNotesForReview[finding.fingerprint]?.trim() ?? '';
    const optimistic: ReviewFindingTriageRecord = {
      reviewId,
      fingerprint: finding.fingerprint,
      status,
      ...(note ? { note } : {}),
      ...(previous?.actor ? { actor: previous.actor } : {}),
      createdAt: previous?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    setFindingPending(finding.fingerprint, true);
    setError(null);
    setRecords((current) =>
      new Map(current).set(finding.fingerprint, optimistic)
    );
    try {
      const response = await fetch(
        `/api/review/${encodeURIComponent(reviewId)}/findings/${encodeURIComponent(finding.fingerprint)}/triage`,
        {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            'x-review-room-action': 'triage',
          },
          body: JSON.stringify({
            status,
            note: note.length > 0 ? note : null,
          }),
        }
      );
      const body = await response.json().catch(() => undefined);
      if (reviewScopeRef.current !== reviewId) {
        return;
      }
      if (!response.ok) {
        const message =
          body &&
          typeof body === 'object' &&
          'error' in body &&
          typeof body.error === 'string'
            ? body.error
            : `triage failed with HTTP ${response.status}`;
        setRecords((current) => {
          const next = new Map(current);
          if (previous) {
            next.set(finding.fingerprint, previous);
          } else {
            next.delete(finding.fingerprint);
          }
          return next;
        });
        setError(message);
        return;
      }
      if (body && typeof body === 'object' && 'record' in body) {
        const record = body.record as ReviewFindingTriageRecord;
        dirtyNotesRef.current.delete(record.fingerprint);
        setRecords((current) =>
          new Map(current).set(record.fingerprint, record)
        );
        setDraftNotes((current) => ({
          ...current,
          [record.fingerprint]: record.note ?? '',
        }));
      }
      router.refresh();
    } catch (requestError) {
      if (reviewScopeRef.current !== reviewId) {
        return;
      }
      setRecords((current) => {
        const next = new Map(current);
        if (previous) {
          next.set(finding.fingerprint, previous);
        } else {
          next.delete(finding.fingerprint);
        }
        return next;
      });
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'triage request failed'
      );
    } finally {
      if (reviewScopeRef.current === reviewId) {
        setFindingPending(finding.fingerprint, false);
      }
    }
  }

  if (findings.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-[var(--muted-foreground)]">
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        No findings in the normalized result.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Filter
            className="h-4 w-4 text-[var(--muted-foreground)]"
            aria-hidden="true"
          />
          <label className="text-xs font-medium text-[var(--muted-foreground)]">
            Priority
            <select
              className="ml-2 h-8 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)]"
              value={filters.priority}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  priority: event.target.value,
                }))
              }
            >
              <option value="all">All</option>
              <option value="0">P0</option>
              <option value="1">P1</option>
              <option value="2">P2</option>
              <option value="3">P3</option>
              <option value="?">P?</option>
            </select>
          </label>
          <label className="text-xs font-medium text-[var(--muted-foreground)]">
            State
            <select
              className="ml-2 h-8 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)]"
              value={filters.state}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  state: event.target.value,
                }))
              }
            >
              <option value="all">All</option>
              {TRIAGE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-[var(--muted-foreground)]">
            Publication
            <select
              className="ml-2 h-8 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)]"
              value={filters.publication}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  publication: event.target.value as PublicationFilter,
                }))
              }
            >
              <option value="all">All</option>
              <option value="published">Published</option>
              <option value="failed">Failed</option>
              <option value="skipped">Skipped</option>
              <option value="unsupported">Unsupported</option>
              <option value="unpublished">Unpublished</option>
            </select>
          </label>
          <label className="text-xs font-medium text-[var(--muted-foreground)]">
            Reviewer
            <select
              className="ml-2 h-8 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)]"
              value={filters.reviewer}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  reviewer: event.target.value,
                }))
              }
            >
              <option value="all">All</option>
              <option value="unassigned">Unassigned</option>
              {reviewers.map((reviewer) => (
                <option key={reviewer} value={reviewer}>
                  {reviewer}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-[var(--muted-foreground)]">
            Provider
            <select
              className="ml-2 h-8 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)]"
              value={filters.provider}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  provider: event.target.value,
                }))
              }
            >
              <option value="all">All</option>
              {provider ? <option value={provider}>{provider}</option> : null}
            </select>
          </label>
          <label className="min-w-52 flex-1 text-xs font-medium text-[var(--muted-foreground)]">
            Path
            <input
              className="ml-2 h-8 w-full max-w-sm rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)]"
              value={filters.path}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  path: event.target.value,
                }))
              }
              placeholder="e.g. src/components/…"
            />
          </label>
        </div>
        <p className="mt-2 text-xs text-[var(--muted-foreground)]">
          {visibleFindings.length} of {findings.length} findings visible
        </p>
      </div>

      {error ? (
        <p className="text-sm text-[var(--destructive)]" role="alert">
          {error}
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] border-separate border-spacing-0 text-left text-sm">
          <thead>
            <tr className="text-xs uppercase text-[var(--muted-foreground)]">
              <th className="border-b border-[var(--border)] px-3 py-2 font-medium">
                Priority
              </th>
              <th className="border-b border-[var(--border)] px-3 py-2 font-medium">
                Finding
              </th>
              <th className="border-b border-[var(--border)] px-3 py-2 font-medium">
                Location
              </th>
              <th className="border-b border-[var(--border)] px-3 py-2 font-medium">
                Triage
              </th>
              <th className="border-b border-[var(--border)] px-3 py-2 font-medium">
                Notes
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleFindings.map((finding) => {
              const record = recordsForReview.get(finding.fingerprint);
              const status = record?.status ?? 'open';
              const publicationStatus = publicationStatusFor(
                publicationStatuses,
                finding
              );
              const note =
                draftNotesForReview[finding.fingerprint] ?? record?.note ?? '';
              return (
                <tr key={finding.fingerprint} className="align-top">
                  <td className="border-b border-[var(--border)] px-3 py-3">
                    <Badge
                      variant={finding.priority === 0 ? 'danger' : 'warning'}
                    >
                      {priorityLabel(finding.priority)}
                    </Badge>
                  </td>
                  <td className="max-w-xl border-b border-[var(--border)] px-3 py-3">
                    <p className="font-medium">{finding.title}</p>
                    <p className="mt-1 line-clamp-3 text-xs text-[var(--muted-foreground)]">
                      {finding.body}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge variant={statusVariant(status)}>{status}</Badge>
                      <Badge variant={publicationVariant(publicationStatus)}>
                        {publicationStatus}
                      </Badge>
                      {record?.actor ? (
                        <Badge variant="neutral">{record.actor}</Badge>
                      ) : null}
                    </div>
                  </td>
                  <td className="border-b border-[var(--border)] px-3 py-3 font-mono text-xs">
                    <span className="block max-w-[18rem] truncate">
                      {fileLabel(finding.codeLocation.absoluteFilePath)}
                    </span>
                    <span className="text-[var(--muted-foreground)]">
                      {finding.codeLocation.lineRange.start}-
                      {finding.codeLocation.lineRange.end}
                    </span>
                    <span className="mt-2 block text-[var(--muted-foreground)]">
                      {Math.round(finding.confidenceScore * 100)}%
                    </span>
                  </td>
                  <td className="border-b border-[var(--border)] px-3 py-3">
                    <select
                      aria-label={`Triage state for ${finding.title}`}
                      className="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-xs text-[var(--foreground)]"
                      disabled={pendingForReview.has(finding.fingerprint)}
                      value={status}
                      onChange={(event) =>
                        void saveTriage(
                          finding,
                          event.target.value as ReviewFindingTriageStatus
                        )
                      }
                    >
                      {TRIAGE_STATUSES.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="border-b border-[var(--border)] px-3 py-3">
                    <div className="flex min-w-[17rem] items-start gap-2">
                      <MessageSquareText
                        className="mt-2 h-4 w-4 shrink-0 text-[var(--muted-foreground)]"
                        aria-hidden="true"
                      />
                      <textarea
                        aria-label={`Triage note for ${finding.title}`}
                        className={cn(
                          'min-h-20 flex-1 resize-y rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-xs text-[var(--foreground)]',
                          pendingForReview.has(finding.fingerprint) &&
                            'opacity-70'
                        )}
                        disabled={pendingForReview.has(finding.fingerprint)}
                        maxLength={4096}
                        value={note}
                        onChange={(event) => {
                          dirtyNotesRef.current.add(finding.fingerprint);
                          setDraftNotes((current) => ({
                            ...current,
                            [finding.fingerprint]: event.target.value,
                          }));
                        }}
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="secondary"
                        aria-label={`Save triage note for ${finding.title}`}
                        disabled={pendingForReview.has(finding.fingerprint)}
                        onClick={() => void saveTriage(finding, status)}
                      >
                        {pendingForReview.has(finding.fingerprint) ? (
                          <Loader2
                            className="h-4 w-4 animate-spin motion-reduce:animate-none"
                            aria-hidden="true"
                          />
                        ) : (
                          <Save className="h-4 w-4" aria-hidden="true" />
                        )}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
