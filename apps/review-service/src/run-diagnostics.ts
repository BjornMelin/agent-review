import { redactSensitiveText } from '@review-agent/review-types';

const MAX_PUBLIC_RUN_ERROR_LENGTH = 240;
const PRIVATE_RUN_ERROR_MARKER_PATTERN =
  /\b(?:args|argv|artifact|authorization|bearer|body|command|cwd|diff|env|environment|file|path|prompt|sandbox output|scope[-_ ]?key|secret|stderr|stdout|stack|token|trace)\b\s*[:=]?/i;
const PATHISH_RUN_ERROR_PATTERN = /[\\/]|(?:^|\s)~\//;
const STACK_FRAME_RUN_ERROR_PATTERN =
  /(?:^|\s)at\s+(?:async\s+)?[\w.$<>]+(?:\s|\()/;

/**
 * Converts an unknown run failure into a public diagnostic string or a safe fallback.
 *
 * @param error - Error-like value that may contain private runtime context.
 * @param fallback - Public message returned when the input is empty or unsafe.
 * @returns Redaction-safe diagnostic text for public run summaries and logs.
 */
export function safeRunDiagnosticMessage(
  error: unknown,
  fallback: string
): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : fallback;
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return fallback;
  }
  const redacted = redactSensitiveText(normalized);
  if (redacted.redactions.apiKeyLike > 0 || redacted.redactions.bearer > 0) {
    return fallback;
  }
  const candidate = redacted.text.trim();
  if (
    !candidate ||
    candidate.length > MAX_PUBLIC_RUN_ERROR_LENGTH ||
    PRIVATE_RUN_ERROR_MARKER_PATTERN.test(candidate) ||
    PATHISH_RUN_ERROR_PATTERN.test(candidate) ||
    STACK_FRAME_RUN_ERROR_PATTERN.test(candidate)
  ) {
    return fallback;
  }
  return candidate;
}
