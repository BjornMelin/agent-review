import type { ReviewRunStatus } from '@review-agent/review-types';

const ABSOLUTE_TIME_FORMAT = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat('en', {
  numeric: 'auto',
});

const STATUS_LABELS = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
} as const satisfies Record<ReviewRunStatus, string>;

export function formatStatus(status: ReviewRunStatus): string {
  return STATUS_LABELS[status];
}

export function formatAbsoluteTime(value: number): string {
  return ABSOLUTE_TIME_FORMAT.format(new Date(value));
}

export function formatRelativeTime(value: number, now = Date.now()): string {
  const deltaSeconds = Math.round((value - now) / 1000);
  const absSeconds = Math.abs(deltaSeconds);
  if (absSeconds < 60) {
    return RELATIVE_TIME_FORMAT.format(deltaSeconds, 'second');
  }
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (Math.abs(deltaMinutes) < 60) {
    return RELATIVE_TIME_FORMAT.format(deltaMinutes, 'minute');
  }
  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) {
    return RELATIVE_TIME_FORMAT.format(deltaHours, 'hour');
  }
  const deltaDays = Math.round(deltaHours / 24);
  return RELATIVE_TIME_FORMAT.format(deltaDays, 'day');
}

export function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ['KB', 'MB', 'GB'] as const;
  let amount = value / 1024;
  for (const unit of units) {
    if (amount < 1024 || unit === 'GB') {
      return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`;
    }
    amount /= 1024;
  }
  return `${value} B`;
}
