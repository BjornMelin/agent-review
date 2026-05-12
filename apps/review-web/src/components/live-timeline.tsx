'use client';

import type {
  LifecycleEvent,
  ReviewRunStatus,
} from '@review-agent/review-types';
import {
  Activity,
  AlertCircle,
  Box,
  CheckCircle2,
  Clock3,
  Radio,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { formatAbsoluteTime } from '@/lib/format';

type TimelineItem = {
  id: string;
  label: string;
  detail?: string;
  timestampMs: number;
  tone: 'neutral' | 'success' | 'danger' | 'info';
};

function itemFromLifecycleEvent(event: LifecycleEvent): TimelineItem {
  switch (event.type) {
    case 'enteredReviewMode':
      return {
        id: event.meta.eventId,
        label: 'Review started',
        detail: event.review,
        timestampMs: event.meta.timestampMs,
        tone: 'info',
      };
    case 'progress':
      return {
        id: event.meta.eventId,
        label: 'Progress',
        detail: event.message,
        timestampMs: event.meta.timestampMs,
        tone: 'neutral',
      };
    case 'exitedReviewMode':
      return {
        id: event.meta.eventId,
        label: 'Review completed',
        detail: event.review,
        timestampMs: event.meta.timestampMs,
        tone: 'success',
      };
    case 'artifactReady':
      return {
        id: event.meta.eventId,
        label: `${event.format.toUpperCase()} artifact ready`,
        timestampMs: event.meta.timestampMs,
        tone: 'success',
      };
    case 'failed':
      return {
        id: event.meta.eventId,
        label: 'Review failed',
        detail: event.message,
        timestampMs: event.meta.timestampMs,
        tone: 'danger',
      };
    case 'cancelled':
      return {
        id: event.meta.eventId,
        label: 'Review cancelled',
        timestampMs: event.meta.timestampMs,
        tone: 'neutral',
      };
  }
}

function EventIcon({ tone }: { tone: TimelineItem['tone'] }): React.ReactNode {
  if (tone === 'success') {
    return <CheckCircle2 className="h-4 w-4" aria-hidden="true" />;
  }
  if (tone === 'danger') {
    return <AlertCircle className="h-4 w-4" aria-hidden="true" />;
  }
  if (tone === 'info') {
    return <Radio className="h-4 w-4" aria-hidden="true" />;
  }
  return <Activity className="h-4 w-4" aria-hidden="true" />;
}

export function LiveTimeline({
  reviewId,
  status,
  createdAt,
  updatedAt,
}: {
  reviewId: string;
  status: ReviewRunStatus;
  createdAt: number;
  updatedAt: number;
}): React.ReactNode {
  const [events, setEvents] = useState<LifecycleEvent[]>([]);
  const [streamState, setStreamState] = useState<
    'connecting' | 'live' | 'closed'
  >('connecting');

  useEffect(() => {
    setEvents([]);
    setStreamState('connecting');
    const source = new EventSource(`/api/review/${reviewId}/events?limit=100`);
    const eventTypes: LifecycleEvent['type'][] = [
      'enteredReviewMode',
      'progress',
      'exitedReviewMode',
      'artifactReady',
      'failed',
      'cancelled',
    ];
    const onEvent = (message: MessageEvent<string>) => {
      setStreamState('live');
      const event = JSON.parse(message.data) as LifecycleEvent;
      setEvents((current) => {
        if (current.some((item) => item.meta.eventId === event.meta.eventId)) {
          return current;
        }
        return [...current, event].sort(
          (left, right) => left.meta.timestampMs - right.meta.timestampMs
        );
      });
    };
    for (const eventType of eventTypes) {
      source.addEventListener(eventType, onEvent);
    }
    source.addEventListener('error', () => {
      setStreamState(
        source.readyState === EventSource.CLOSED ? 'closed' : 'connecting'
      );
    });
    return () => {
      source.close();
    };
  }, [reviewId]);

  const items = useMemo<TimelineItem[]>(() => {
    const lifecycleItems = events.map(itemFromLifecycleEvent);
    return [
      {
        id: 'created',
        label: 'Run accepted',
        timestampMs: createdAt,
        tone: 'info' as const,
      },
      ...lifecycleItems,
      {
        id: 'status',
        label: `Current status: ${status}`,
        timestampMs: updatedAt,
        tone: status === 'failed' ? ('danger' as const) : ('neutral' as const),
      },
    ].sort((left, right) => left.timestampMs - right.timestampMs);
  }, [createdAt, events, status, updatedAt]);

  return (
    <section aria-labelledby="timeline-heading" className="min-h-0">
      <div className="flex items-center justify-between gap-3">
        <h2 id="timeline-heading" className="text-sm font-semibold">
          Timeline
        </h2>
        <Badge variant={streamState === 'live' ? 'success' : 'neutral'}>
          {streamState}
        </Badge>
      </div>
      <ol className="mt-4 space-y-3" aria-live="polite">
        {items.map((item) => (
          <li key={item.id} className="grid grid-cols-[1.5rem_1fr] gap-3">
            <span className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--muted-foreground)]">
              <EventIcon tone={item.tone} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {item.label}
              </span>
              {item.detail ? (
                <span className="block break-words text-xs text-[var(--muted-foreground)]">
                  {item.detail}
                </span>
              ) : null}
              <span className="mt-1 flex items-center gap-1 text-xs text-[var(--muted-foreground)]">
                <Clock3 className="h-3 w-3" aria-hidden="true" />
                {formatAbsoluteTime(item.timestampMs)}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {events.length === 0 ? (
        <div className="mt-6 flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          <Box className="h-4 w-4" aria-hidden="true" />
          Waiting for retained lifecycle events.
        </div>
      ) : null}
    </section>
  );
}
