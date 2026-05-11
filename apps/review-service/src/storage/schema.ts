import type {
  LifecycleEvent,
  OutputFormat,
  ReviewRequest,
  ReviewRunStatus,
} from '@review-agent/review-types';
import { isNotNull, relations } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** Defines allowed lifecycle states for persisted review runs and transitions. */
export const reviewRunStatusEnum = pgEnum('review_run_status', [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

/** Defines allowed generated artifact formats for persisted artifact metadata. */
export const outputFormatEnum = pgEnum('review_output_format', [
  'sarif',
  'json',
  'markdown',
]);

/** Stores canonical review run records, retention markers, and event cursors. */
export const reviewRuns = pgTable(
  'review_runs',
  {
    reviewId: text('review_id').primaryKey(),
    runId: text('run_id').notNull(),
    status: reviewRunStatusEnum('status').$type<ReviewRunStatus>().notNull(),
    request: jsonb('request').$type<ReviewRequest>().notNull(),
    requestSummary: jsonb('request_summary')
      .$type<{
        provider: ReviewRequest['provider'];
        executionMode: ReviewRequest['executionMode'];
        targetType: ReviewRequest['target']['type'];
        outputFormats: ReviewRequest['outputFormats'];
      }>()
      .notNull(),
    result: jsonb('result').$type<unknown>(),
    error: text('error'),
    detachedRunId: text('detached_run_id'),
    workflowRunId: text('workflow_run_id'),
    sandboxId: text('sandbox_id'),
    leaseOwner: text('lease_owner'),
    leaseScopeKey: text('lease_scope_key'),
    leaseAcquiredAt: timestamp('lease_acquired_at', {
      mode: 'date',
      withTimezone: true,
    }),
    leaseHeartbeatAt: timestamp('lease_heartbeat_at', {
      mode: 'date',
      withTimezone: true,
    }),
    leaseExpiresAt: timestamp('lease_expires_at', {
      mode: 'date',
      withTimezone: true,
    }),
    cancelRequestedAt: timestamp('cancel_requested_at', {
      mode: 'date',
      withTimezone: true,
    }),
    eventSequence: integer('event_sequence').notNull().default(0),
    createdAt: timestamp('created_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    completedAt: timestamp('completed_at', {
      mode: 'date',
      withTimezone: true,
    }),
    retentionExpiresAt: timestamp('retention_expires_at', {
      mode: 'date',
      withTimezone: true,
    }),
    deletedAt: timestamp('deleted_at', {
      mode: 'date',
      withTimezone: true,
    }),
  },
  (table) => [
    index('review_runs_status_idx').on(table.status),
    index('review_runs_lease_expires_at_idx').on(table.leaseExpiresAt),
    index('review_runs_lease_scope_key_idx').on(table.leaseScopeKey),
    index('review_runs_updated_at_idx').on(table.updatedAt),
    index('review_runs_retention_expires_at_idx').on(table.retentionExpiresAt),
    uniqueIndex('review_runs_detached_run_id_idx')
      .on(table.detachedRunId)
      .where(isNotNull(table.detachedRunId)),
  ]
);

/** Stores ordered lifecycle events for replay and server-sent event cursors. */
export const reviewEvents = pgTable(
  'review_events',
  {
    reviewId: text('review_id')
      .notNull()
      .references(() => reviewRuns.reviewId, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    sequence: integer('sequence').notNull(),
    event: jsonb('event').$type<LifecycleEvent>().notNull(),
    createdAt: timestamp('created_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.reviewId, table.sequence],
      name: 'review_events_review_id_sequence_pk',
    }),
    uniqueIndex('review_events_event_id_idx').on(table.eventId),
    index('review_events_review_id_created_at_idx').on(
      table.reviewId,
      table.createdAt
    ),
  ]
);

/** Stores generated artifact metadata and bodies outside the run result JSON. */
export const reviewArtifacts = pgTable(
  'review_artifacts',
  {
    artifactId: text('artifact_id').primaryKey(),
    reviewId: text('review_id')
      .notNull()
      .references(() => reviewRuns.reviewId, { onDelete: 'cascade' }),
    format: outputFormatEnum('format').$type<OutputFormat>().notNull(),
    contentType: text('content_type').notNull(),
    byteLength: integer('byte_length').notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    uniqueIndex('review_artifacts_review_id_format_idx').on(
      table.reviewId,
      table.format
    ),
    uniqueIndex('review_artifacts_storage_key_idx').on(table.storageKey),
  ]
);

/** Stores append-only review status transitions for audit and diagnostics. */
export const reviewStatusTransitions = pgTable(
  'review_status_transitions',
  {
    transitionId: text('transition_id').primaryKey(),
    reviewId: text('review_id')
      .notNull()
      .references(() => reviewRuns.reviewId, { onDelete: 'cascade' }),
    fromStatus: reviewRunStatusEnum('from_status').$type<ReviewRunStatus>(),
    toStatus: reviewRunStatusEnum('to_status')
      .$type<ReviewRunStatus>()
      .notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    index('review_status_transitions_review_id_created_at_idx').on(
      table.reviewId,
      table.createdAt
    ),
  ]
);

/** Declares run-to-child relations for Drizzle relational queries. */
export const reviewRunRelations = relations(reviewRuns, ({ many }) => ({
  artifacts: many(reviewArtifacts),
  events: many(reviewEvents),
  statusTransitions: many(reviewStatusTransitions),
}));

/** Declares lifecycle-event-to-run relations for Drizzle relational queries. */
export const reviewEventRelations = relations(reviewEvents, ({ one }) => ({
  run: one(reviewRuns, {
    fields: [reviewEvents.reviewId],
    references: [reviewRuns.reviewId],
  }),
}));

/** Declares artifact-to-run relations for Drizzle relational queries. */
export const reviewArtifactRelations = relations(
  reviewArtifacts,
  ({ one }) => ({
    run: one(reviewRuns, {
      fields: [reviewArtifacts.reviewId],
      references: [reviewRuns.reviewId],
    }),
  })
);

/** Declares status-transition-to-run relations for Drizzle relational queries. */
export const reviewStatusTransitionRelations = relations(
  reviewStatusTransitions,
  ({ one }) => ({
    run: one(reviewRuns, {
      fields: [reviewStatusTransitions.reviewId],
      references: [reviewRuns.reviewId],
    }),
  })
);
