import { describe, expect, it } from 'vitest';
import { safeRunErrorForStatus } from './run-diagnostics.js';

describe('safeRunErrorForStatus', () => {
  it('applies one public terminal-error policy', () => {
    expect({
      safe: safeRunErrorForStatus(
        'failed',
        ' provider   returned invalid JSON '
      ),
      token: safeRunErrorForStatus(
        'failed',
        'provider failed sk-abcdefghijklmnopqrstuvwxyz123456'
      ),
      path: safeRunErrorForStatus('failed', 'provider failed at /repo/private'),
      stack: safeRunErrorForStatus(
        'failed',
        'provider failed at async runReview (provider)'
      ),
      privateMarker: safeRunErrorForStatus(
        'failed',
        'provider failed prompt: review this'
      ),
      overlength: safeRunErrorForStatus('failed', 'x'.repeat(241)),
      cancelled: safeRunErrorForStatus(
        'cancelled',
        'user requested cancellation'
      ),
      detachedStart: safeRunErrorForStatus(
        'failed',
        'detached start failed token: private'
      ),
      detachedRun: safeRunErrorForStatus(
        'failed',
        'detached worker failed cwd=/repo/private'
      ),
      leaseSentinel: safeRunErrorForStatus('failed', 'runtime lease expired'),
      missingRunSentinel: safeRunErrorForStatus(
        'failed',
        'detached run not found'
      ),
      missing: safeRunErrorForStatus('failed'),
    }).toEqual({
      safe: 'provider returned invalid JSON',
      token: 'review run failed',
      path: 'review run failed',
      stack: 'review run failed',
      privateMarker: 'review run failed',
      overlength: 'review run failed',
      cancelled: 'review run cancelled',
      detachedStart: 'detached start failed',
      detachedRun: 'detached run failed',
      leaseSentinel: 'runtime lease expired',
      missingRunSentinel: 'detached run not found',
      missing: undefined,
    });
  });
});
