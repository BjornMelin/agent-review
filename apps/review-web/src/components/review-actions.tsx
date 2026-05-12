'use client';

import { Loader2, PauseCircle, Send } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function ReviewActions({
  reviewId,
  canCancel,
  canPublish,
}: {
  reviewId: string;
  canCancel: boolean;
  canPublish: boolean;
}): React.ReactNode {
  const router = useRouter();
  const [pending, setPending] = useState<'cancel' | 'publish' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function postAction(action: 'cancel' | 'publish'): Promise<void> {
    setPending(action);
    setError(null);
    try {
      const response = await fetch(`/api/review/${reviewId}/${action}`, {
        method: 'POST',
        headers: { 'x-review-room-action': action },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        const message =
          body &&
          typeof body === 'object' &&
          'error' in body &&
          typeof body.error === 'string'
            ? body.error
            : `${action} failed with HTTP ${response.status}`;
        setError(message);
        return;
      }
      router.refresh();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : `${action} request failed`
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={!canPublish || pending !== null}
          onClick={() => void postAction('publish')}
        >
          {pending === 'publish' ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="h-4 w-4" aria-hidden="true" />
          )}
          Publish
        </Button>
        <Button
          type="button"
          variant="danger"
          disabled={!canCancel || pending !== null}
          onClick={() => void postAction('cancel')}
        >
          {pending === 'cancel' ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <PauseCircle className="h-4 w-4" aria-hidden="true" />
          )}
          Cancel
        </Button>
      </div>
      {error ? (
        <p className="max-w-xs text-xs text-[var(--destructive)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
