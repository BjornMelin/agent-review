import type { ReviewRunStatus } from '@review-agent/review-types';
import { Badge } from '@/components/ui/badge';
import { formatStatus } from '@/lib/format';

const STATUS_VARIANTS = {
  queued: 'warning',
  running: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
} as const satisfies Record<
  ReviewRunStatus,
  'neutral' | 'success' | 'warning' | 'danger' | 'info'
>;

export function StatusBadge({
  status,
}: {
  status: ReviewRunStatus;
}): React.ReactNode {
  return (
    <Badge variant={STATUS_VARIANTS[status]}>{formatStatus(status)}</Badge>
  );
}
