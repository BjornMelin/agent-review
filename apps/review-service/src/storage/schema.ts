import type {
  LifecycleEvent,
  OutputFormat,
  ReviewAuthPrincipal,
  ReviewAuthScope,
  ReviewPublicationChannel,
  ReviewPublicationRecord,
  ReviewPublicationStatus,
  ReviewRepositoryAuthorization,
  ReviewRequest,
  ReviewRunAuthorization,
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

/** Defines outbound GitHub publication side-effect channels. */
export const reviewPublicationChannelEnum = pgEnum(
  'review_publication_channel',
  ['checkRun', 'sarif', 'pullRequestComment']
);

/** Defines terminal publication state for one GitHub side effect. */
export const reviewPublicationStatusEnum = pgEnum('review_publication_status', [
  'published',
  'skipped',
  'unsupported',
  'failed',
]);

/** Stores canonical review run records, retention markers, and event cursors. */
export const reviewRuns = pgTable(
  'review_runs',
  {
    reviewId: text('review_id').primaryKey(),
    runId: text('run_id').notNull(),
    status: reviewRunStatusEnum('status').$type<ReviewRunStatus>().notNull(),
    request: jsonb('request').$type<ReviewRequest>().notNull(),
    authorization: jsonb('authorization').$type<ReviewRunAuthorization>(),
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
    authActorType: text('auth_actor_type'),
    authActorId: text('auth_actor_id'),
    githubInstallationId: text('github_installation_id'),
    githubRepositoryId: text('github_repository_id'),
    githubOwner: text('github_owner'),
    githubRepo: text('github_repo'),
    requestHash: text('request_hash'),
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
    index('review_runs_github_repo_idx').on(
      table.githubInstallationId,
      table.githubRepositoryId
    ),
    index('review_runs_auth_actor_idx').on(
      table.authActorType,
      table.authActorId
    ),
    index('review_runs_request_hash_idx').on(table.requestHash),
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

/** Stores idempotency and outcome state for outbound GitHub publication writes. */
export const reviewPublications = pgTable(
  'review_publications',
  {
    publicationId: text('publication_id').primaryKey(),
    reviewId: text('review_id')
      .notNull()
      .references(() => reviewRuns.reviewId, { onDelete: 'cascade' }),
    channel: reviewPublicationChannelEnum('channel')
      .$type<ReviewPublicationChannel>()
      .notNull(),
    targetKey: text('target_key').notNull(),
    status: reviewPublicationStatusEnum('status')
      .$type<ReviewPublicationStatus>()
      .notNull(),
    externalId: text('external_id'),
    externalUrl: text('external_url'),
    marker: text('marker'),
    message: text('message'),
    error: text('error'),
    metadata: jsonb('metadata').$type<ReviewPublicationRecord['metadata']>(),
    createdAt: timestamp('created_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    uniqueIndex('review_publications_review_channel_target_idx').on(
      table.reviewId,
      table.channel,
      table.targetKey
    ),
    index('review_publications_review_id_idx').on(table.reviewId),
  ]
);

/** Stores GitHub user identities that have authorized the service. */
export const githubUsers = pgTable('github_users', {
  githubUserId: text('github_user_id').primaryKey(),
  login: text('login').notNull(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', {
    mode: 'date',
    withTimezone: true,
  }).notNull(),
  updatedAt: timestamp('updated_at', {
    mode: 'date',
    withTimezone: true,
  }).notNull(),
});

/** Stores GitHub App installations available to the service. */
export const githubInstallations = pgTable('github_installations', {
  installationId: text('installation_id').primaryKey(),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type').notNull(),
  permissions: jsonb('permissions').$type<Record<string, string>>().notNull(),
  repositorySelection: text('repository_selection').notNull(),
  suspendedAt: timestamp('suspended_at', {
    mode: 'date',
    withTimezone: true,
  }),
  createdAt: timestamp('created_at', {
    mode: 'date',
    withTimezone: true,
  }).notNull(),
  updatedAt: timestamp('updated_at', {
    mode: 'date',
    withTimezone: true,
  }).notNull(),
});

/** Stores repositories reachable through GitHub App installations. */
export const githubRepositories = pgTable(
  'github_repositories',
  {
    repositoryId: text('repository_id').primaryKey(),
    installationId: text('installation_id')
      .notNull()
      .references(() => githubInstallations.installationId, {
        onDelete: 'cascade',
      }),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    fullName: text('full_name').notNull(),
    visibility: text('visibility').notNull(),
    permissions: jsonb('permissions')
      .$type<ReviewRepositoryAuthorization['permissions']>()
      .notNull(),
    deletedAt: timestamp('deleted_at', {
      mode: 'date',
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    uniqueIndex('github_repositories_owner_name_idx').on(
      table.owner,
      table.name
    ),
    index('github_repositories_installation_idx').on(table.installationId),
  ]
);

/** Stores user-specific repository permission snapshots. */
export const githubRepositoryPermissions = pgTable(
  'github_repository_permissions',
  {
    githubUserId: text('github_user_id')
      .notNull()
      .references(() => githubUsers.githubUserId, { onDelete: 'cascade' }),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => githubRepositories.repositoryId, {
        onDelete: 'cascade',
      }),
    permission: text('permission').notNull(),
    updatedAt: timestamp('updated_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.githubUserId, table.repositoryId],
      name: 'github_repository_permissions_user_repo_pk',
    }),
  ]
);

/** Stores hashed scoped service tokens for CI and automation clients. */
export const serviceTokens = pgTable(
  'service_tokens',
  {
    tokenId: text('token_id').primaryKey(),
    tokenPrefix: text('token_prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    name: text('name').notNull(),
    scopes: jsonb('scopes').$type<ReviewAuthScope[]>().notNull(),
    repository: jsonb('repository')
      .$type<ReviewRepositoryAuthorization>()
      .notNull(),
    createdBy: jsonb('created_by').$type<ReviewAuthPrincipal>(),
    expiresAt: timestamp('expires_at', {
      mode: 'date',
      withTimezone: true,
    }),
    revokedAt: timestamp('revoked_at', {
      mode: 'date',
      withTimezone: true,
    }),
    lastUsedAt: timestamp('last_used_at', {
      mode: 'date',
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    uniqueIndex('service_tokens_prefix_idx').on(table.tokenPrefix),
    index('service_tokens_revoked_at_idx').on(table.revokedAt),
  ]
);

/** Stores append-only security audit events for authn/authz decisions. */
export const authAuditEvents = pgTable(
  'auth_audit_events',
  {
    auditEventId: text('audit_event_id').primaryKey(),
    eventType: text('event_type').notNull(),
    operation: text('operation').notNull(),
    result: text('result').notNull(),
    reason: text('reason').notNull(),
    status: integer('status').notNull(),
    principal: jsonb('principal').$type<ReviewAuthPrincipal>(),
    tokenId: text('token_id'),
    tokenPrefix: text('token_prefix'),
    repository: jsonb('repository').$type<ReviewRepositoryAuthorization>(),
    reviewId: text('review_id'),
    requestId: text('request_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    index('auth_audit_events_created_at_idx').on(table.createdAt),
    index('auth_audit_events_review_id_idx').on(table.reviewId),
    index('auth_audit_events_token_id_idx').on(table.tokenId),
  ]
);

/** Declares run-to-child relations for Drizzle relational queries. */
export const reviewRunRelations = relations(reviewRuns, ({ many }) => ({
  artifacts: many(reviewArtifacts),
  events: many(reviewEvents),
  publications: many(reviewPublications),
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

/** Declares publication-to-run relations for Drizzle relational queries. */
export const reviewPublicationRelations = relations(
  reviewPublications,
  ({ one }) => ({
    run: one(reviewRuns, {
      fields: [reviewPublications.reviewId],
      references: [reviewRuns.reviewId],
    }),
  })
);
