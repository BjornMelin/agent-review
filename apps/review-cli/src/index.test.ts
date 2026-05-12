import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReviewStartRequest } from '@review-agent/review-types';
import { describe, expect, it, vi } from 'vitest';

import {
  fetchReviewArtifact,
  ServiceClientError,
  startReview,
} from './service-client.js';

const cliPath = fileURLToPath(new URL('./index.ts', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const HOSTED_SERVICE_ENV_KEYS = [
  'REVIEW_AGENT_SERVICE_URL',
  'REVIEW_AGENT_SERVICE_TOKEN',
  'REVIEW_SERVICE_URL',
  'REVIEW_SERVICE_TOKEN',
] as const;

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type CliBufferResult = Omit<CliResult, 'stdout'> & {
  stdout: Buffer;
};

type RecordedRequest = {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
};

function childEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of HOSTED_SERVICE_ENV_KEYS) {
    delete env[key];
  }
  return {
    ...env,
    AI_GATEWAY_API_KEY: 'test-gateway-key',
    OPENROUTER_API_KEY: 'test-openrouter-key',
    ...overrides,
  };
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('tsx', [cliPath, ...args], {
      cwd: repoRoot,
      env: childEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function runCliWithBufferedStdout(
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<CliBufferResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('tsx', [cliPath, ...args], {
      cwd: repoRoot,
      env: childEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) =>
      resolve({ status, stdout: Buffer.concat(stdoutChunks), stderr })
    );
  });
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
  }
  return body;
}

async function startReviewServiceFixture(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: string,
    record: RecordedRequest
  ) => void | Promise<void>
): Promise<{
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    const record: RecordedRequest = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body,
    };
    requests.push(record);
    try {
      await handler(request, response, body, record);
    } catch (error) {
      response.statusCode = 500;
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind fixture server');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

function writeJsonResponse(
  response: ServerResponse,
  status: number,
  payload: unknown
): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(payload));
}

function runDoctor(provider: 'gateway' | 'openrouter') {
  return spawnSync(
    'tsx',
    [cliPath, 'doctor', '--provider', provider, '--json'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        AI_GATEWAY_API_KEY: 'test-gateway-key',
        OPENROUTER_API_KEY: '',
      },
    }
  );
}

describe('review-agent doctor provider filtering', () => {
  it('prints provider policy details in the model catalog', () => {
    const result = spawnSync('tsx', [cliPath, 'models', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'gateway:openai/gpt-5',
          policy: expect.objectContaining({
            fallbackOrder: [
              'gateway:anthropic/claude-sonnet-4-5',
              'gateway:google/gemini-3-flash',
            ],
            maxInputChars: 120_000,
            maxOutputTokens: 4096,
            timeoutMs: 120_000,
            maxAttempts: 3,
            disallowPromptTraining: true,
          }),
        }),
      ])
    );
  });

  it('does not fail gateway checks when OpenRouter auth is absent', () => {
    const result = runDoctor('gateway');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('AI Gateway auth detected');
    expect(result.stdout).not.toContain('OPENROUTER_API_KEY');
  });

  it('still reports missing OpenRouter auth for the OpenRouter route', () => {
    const result = runDoctor('openrouter');

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('OPENROUTER_API_KEY is not configured');
  });

  it('maps invalid doctor provider filters to usage failures', () => {
    const result = spawnSync(
      'tsx',
      [cliPath, 'doctor', '--provider', 'nope', '--json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
        },
      }
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'invalid provider filter "nope"; expected codex|gateway|openrouter|all'
    );
    expect(result.stderr).not.toContain('at Command');
  });
});

describe('review-agent hosted service commands', () => {
  it('submits detached reviews with shared DTO payloads and bearer auth', async () => {
    const fixture = await startReviewServiceFixture(
      async (request, response) => {
        expect(request.method).toBe('POST');
        expect(request.url).toBe('/v1/review/start');
        writeJsonResponse(response, 202, {
          reviewId: 'review_1',
          status: 'queued',
          detachedRunId: 'workflow_1',
        });
      }
    );
    try {
      const result = await runCli([
        'submit',
        '--prompt',
        'review this branch',
        '--provider',
        'gateway',
        '--format',
        'json',
        '--service-url',
        fixture.url,
        '--service-token',
        'rat_test_secret',
        '--repo',
        'octo-org/agent-review',
        '--repository-id',
        '987654',
        '--installation-id',
        '123456',
        '--pull-request',
        '42',
      ]);

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('rat_test_secret');
      expect(JSON.parse(result.stdout)).toEqual({
        reviewId: 'review_1',
        status: 'queued',
        detachedRunId: 'workflow_1',
      });
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]?.authorization).toBe('Bearer rat_test_secret');
      const body = JSON.parse(fixture.requests[0]?.body ?? '{}');
      expect(body).toMatchObject({
        delivery: 'detached',
        repository: {
          provider: 'github',
          owner: 'octo-org',
          name: 'agent-review',
          repositoryId: 987654,
          installationId: 123456,
          pullRequestNumber: 42,
        },
        request: {
          target: { type: 'custom', instructions: 'review this branch' },
          provider: 'openaiCompatible',
          model: 'gateway:openai/gpt-5',
          outputFormats: ['json'],
          detached: true,
        },
      });
    } finally {
      await fixture.close();
    }
  });

  it('routes run --detached through the hosted service instead of local execution', async () => {
    const fixture = await startReviewServiceFixture((_request, response) => {
      writeJsonResponse(response, 202, {
        reviewId: 'review_detached',
        status: 'queued',
        detachedRunId: 'workflow_detached',
      });
    });
    try {
      const result = await runCli([
        'run',
        '--prompt',
        'review this',
        '--detached',
        '--service-url',
        fixture.url,
        '--service-token',
        'rat_test_secret',
      ]);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        reviewId: 'review_detached',
        status: 'queued',
      });
      expect(fixture.requests[0]?.url).toBe('/v1/review/start');
      expect(JSON.parse(fixture.requests[0]?.body ?? '{}')).toMatchObject({
        delivery: 'detached',
        request: { detached: true },
      });
    } finally {
      await fixture.close();
    }
  });

  it('maps hosted auth failures to auth exit code without echoing tokens', async () => {
    const fixture = await startReviewServiceFixture((_request, response) => {
      writeJsonResponse(response, 401, { error: 'service token invalid' });
    });
    try {
      const result = await runCli([
        'status',
        'review_1',
        '--service-url',
        fixture.url,
        '--service-token',
        'rat_should_not_echo',
      ]);

      expect(result.status).toBe(3);
      expect(result.stderr).toContain('service token invalid');
      expect(result.stderr).not.toContain('rat_should_not_echo');
    } finally {
      await fixture.close();
    }
  });

  it('redacts env-sourced service tokens from service error messages', async () => {
    const fixture = await startReviewServiceFixture((request, response) => {
      writeJsonResponse(response, 401, {
        error: `invalid auth ${request.headers.authorization ?? ''}`,
      });
    });
    try {
      const result = await runCli(
        ['status', 'review_1', '--service-url', fixture.url],
        {
          REVIEW_AGENT_SERVICE_TOKEN: 'rat_env_secret_should_not_echo',
        }
      );

      expect(result.status).toBe(3);
      expect(result.stderr).toContain('invalid auth Bearer [REDACTED]');
      expect(result.stderr).not.toContain('rat_env_secret_should_not_echo');
    } finally {
      await fixture.close();
    }
  });

  it('rejects plaintext remote service urls before sending bearer tokens', async () => {
    const result = await runCli([
      'status',
      'review_1',
      '--service-url',
      'http://review-service.example.test',
      '--service-token',
      'rat_should_not_send',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'review service URL must use HTTPS unless it targets localhost or loopback'
    );
    expect(result.stderr).not.toContain('rat_should_not_send');
  });

  it('rejects dns names that only look like loopback hosts', async () => {
    for (const serviceUrl of [
      'http://127.example.test',
      'http://127.0.0.1.example.test',
    ]) {
      const result = await runCli([
        'status',
        'review_1',
        '--service-url',
        serviceUrl,
        '--service-token',
        'rat_should_not_send',
      ]);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        'review service URL must use HTTPS unless it targets localhost or loopback'
      );
      expect(result.stderr).not.toContain('rat_should_not_send');
    }
  });

  it('rejects service urls with embedded credentials without echoing them', async () => {
    const result = await runCli([
      'status',
      'review_1',
      '--service-url',
      'https://service-user:service-pass@127.0.0.1:1',
      '--service-token',
      'rat_should_not_send',
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'review service URL must not contain credentials'
    );
    expect(result.stderr).not.toContain('service-user');
    expect(result.stderr).not.toContain('service-pass');
    expect(result.stderr).not.toContain('rat_should_not_send');
  });

  it('rejects service urls with query strings or fragments', async () => {
    for (const serviceUrl of [
      'http://127.0.0.1:3042?debug=true',
      'http://127.0.0.1:3042#fragment',
    ]) {
      const result = await runCli([
        'status',
        'review_1',
        '--service-url',
        serviceUrl,
        '--service-token',
        'rat_should_not_send',
      ]);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        'review service URL must not include query strings or fragments'
      );
      expect(result.stderr).not.toContain('debug=true');
      expect(result.stderr).not.toContain('#fragment');
      expect(result.stderr).not.toContain('rat_should_not_send');
    }
  });

  it('redacts env-sourced service tokens in top-level CLI errors', async () => {
    const result = await runCli(
      [
        'status',
        'review_1',
        '--service-url',
        'not-a-url plain_env_token_should_not_echo',
      ],
      {
        REVIEW_AGENT_SERVICE_TOKEN: 'plain_env_token_should_not_echo',
      }
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid review service URL');
    expect(result.stderr).not.toContain('plain_env_token_should_not_echo');
  });

  it('allows HTTPS service urls without contacting them during config validation', async () => {
    const result = await runCli([
      'status',
      'review_1',
      '--service-url',
      'https://127.0.0.1:1',
      '--service-token',
      'rat_https_allowed',
    ]);

    expect(result.status).toBe(4);
    expect(result.stderr).toContain('review service request failed');
    expect(result.stderr).not.toContain('review service URL must use HTTPS');
    expect(result.stderr).not.toContain('rat_https_allowed');
  });

  it('fetches hosted review status as shared DTO json', async () => {
    const fixture = await startReviewServiceFixture((_request, response) => {
      writeJsonResponse(response, 200, {
        reviewId: 'review_1',
        status: 'running',
        createdAt: 1,
        updatedAt: 2,
      });
    });
    try {
      const result = await runCli([
        'status',
        'review_1',
        '--service-url',
        fixture.url,
        '--service-token',
        'rat_test_secret',
      ]);

      expect(result.status).toBe(0);
      expect(fixture.requests[0]?.url).toBe('/v1/review/review_1');
      expect(JSON.parse(result.stdout)).toEqual({
        reviewId: 'review_1',
        status: 'running',
        createdAt: 1,
        updatedAt: 2,
      });
    } finally {
      await fixture.close();
    }
  });

  it('times out one-shot hosted service requests', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        })
    );
    vi.useFakeTimers();
    try {
      const request: ReviewStartRequest = {
        request: {
          cwd: '/tmp/repo',
          target: { type: 'custom', instructions: 'review this branch' },
          provider: 'codexDelegate',
          executionMode: 'localTrusted',
          outputFormats: ['json'],
        },
        delivery: 'detached',
      };
      const pending = startReview(
        { baseUrl: 'http://127.0.0.1:3042', token: 'rat_test_secret' },
        request
      );
      const captured = pending.then(
        () => {
          throw new Error('expected startReview to time out');
        },
        (error: unknown) => error
      );

      await vi.advanceTimersByTimeAsync(30_000);
      const error = await captured;
      expect(error).toBeInstanceOf(ServiceClientError);
      expect(error).toMatchObject({ exitCode: 4 });
      expect((error as Error).message).toBe(
        'review service request timed out after 30000ms'
      );
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps one-shot request timeouts active while reading response bodies', async () => {
    let wroteBody: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      wroteBody = resolve;
    });
    const fixture = await startReviewServiceFixture((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
      });
      response.write(Buffer.from([0x41]));
      wroteBody();
    });
    vi.useFakeTimers();
    try {
      const pending = fetchReviewArtifact(
        { baseUrl: fixture.url, token: 'rat_test_secret' },
        'review_1',
        'json'
      );
      const captured = pending.then(
        () => {
          throw new Error('expected fetchReviewArtifact to time out');
        },
        (error: unknown) => error
      );

      await bodyStarted;
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await captured;
      expect(error).toBeInstanceOf(ServiceClientError);
      expect(error).toMatchObject({ exitCode: 4 });
      expect((error as Error).message).toBe(
        'review service request timed out after 30000ms'
      );
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  it('streams lifecycle events through post-completion artifacts', async () => {
    const fixture = await startReviewServiceFixture((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
      });
      response.write(
        `event: progress\nid: event_1\ndata: ${JSON.stringify({
          type: 'progress',
          message: 'started',
          meta: {
            eventId: 'event_1',
            timestampMs: 1,
            correlation: { reviewId: 'review_1' },
          },
        })}\n\n`
      );
      response.write(
        `event: exitedReviewMode\nid: event_2\ndata: ${JSON.stringify({
          type: 'exitedReviewMode',
          review: 'review requested',
          meta: {
            eventId: 'event_2',
            timestampMs: 2,
            correlation: { reviewId: 'review_1' },
          },
        })}\n\n`
      );
      response.write('event: keepalive\ndata: \n\n');
      response.write(
        `event: artifactReady\nid: event_3\ndata: ${JSON.stringify({
          type: 'artifactReady',
          format: 'json',
          meta: {
            eventId: 'event_3',
            timestampMs: 3,
            correlation: { reviewId: 'review_1' },
          },
        })}\n\n`
      );
      response.write('event: keepalive\ndata: \n\n');
      response.end();
    });
    try {
      const result = await runCli([
        'watch',
        'review_1',
        '--after-event-id',
        'event_0',
        '--limit',
        '5',
        '--service-url',
        fixture.url,
        '--service-token',
        'rat_test_secret',
      ]);

      expect(result.status).toBe(0);
      expect(fixture.requests[0]?.url).toBe(
        '/v1/review/review_1/events?afterEventId=event_0&limit=5'
      );
      const events = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events).toMatchObject([
        { type: 'progress', message: 'started' },
        { type: 'exitedReviewMode', review: 'review requested' },
        { type: 'artifactReady', format: 'json' },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it('rejects watch responses with non-SSE content types', async () => {
    const fixture = await startReviewServiceFixture((_request, response) => {
      writeJsonResponse(response, 200, { ok: true });
    });
    try {
      const result = await runCli([
        'watch',
        'review_1',
        '--service-url',
        fixture.url,
        '--service-token',
        'rat_test_secret',
      ]);

      expect(result.status).toBe(4);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        "expected Content-Type 'text/event-stream' for review event stream but got 'application/json'"
      );
    } finally {
      await fixture.close();
    }
  });

  it('fails watch when the event stream closes before a terminal event', async () => {
    const fixture = await startReviewServiceFixture((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
      });
      response.end(
        `event: progress\nid: event_1\ndata: ${JSON.stringify({
          type: 'progress',
          message: 'started',
          meta: {
            eventId: 'event_1',
            timestampMs: 1,
            correlation: { reviewId: 'review_1' },
          },
        })}\n\n`
      );
    });
    try {
      const result = await runCli([
        'watch',
        'review_1',
        '--service-url',
        fixture.url,
        '--service-token',
        'rat_test_secret',
      ]);

      expect(result.status).toBe(4);
      expect(result.stdout).toContain('"type":"progress"');
      expect(result.stderr).toContain(
        'review service event stream ended before a terminal lifecycle event'
      );
    } finally {
      await fixture.close();
    }
  });

  it('writes raw artifacts to the requested output path', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'review-cli-'));
    const outputPath = join(tempDir, 'review.md');
    const fixture = await startReviewServiceFixture((_request, response) => {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      response.end('# Review\n\nNo findings.\n');
    });
    try {
      const result = await runCli([
        'artifact',
        'review_1',
        'markdown',
        '--output',
        outputPath,
        '--service-url',
        fixture.url,
        '--service-token',
        'rat_test_secret',
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(fixture.requests[0]?.url).toBe(
        '/v1/review/review_1/artifacts/markdown'
      );
      await expect(readFile(outputPath, 'utf8')).resolves.toBe(
        '# Review\n\nNo findings.\n'
      );
    } finally {
      await fixture.close();
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it('rejects invalid artifact formats before service configuration', async () => {
    const fixture = await startReviewServiceFixture((_request, response) => {
      response.statusCode = 500;
      response.end('should not be called');
    });
    try {
      const result = await runCli([
        'artifact',
        'review_1',
        'html',
        '--service-url',
        fixture.url,
      ]);

      expect(result.status).toBe(2);
      expect(result.stderr).not.toContain('review service token is required');
      expect(fixture.requests).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it('writes raw artifacts to stdout without appending a newline', async () => {
    const fixture = await startReviewServiceFixture((_request, response) => {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end('{"ok":true}');
    });
    try {
      const result = await runCli([
        'artifact',
        'review_1',
        'json',
        '--service-url',
        fixture.url,
        '--service-token',
        'rat_test_secret',
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('{"ok":true}');
      expect(fixture.requests[0]?.url).toBe(
        '/v1/review/review_1/artifacts/json'
      );
    } finally {
      await fixture.close();
    }
  });

  it('writes binary artifact bytes to stdout without UTF-8 normalization', async () => {
    const artifactBytes = Buffer.from([0x00, 0xff, 0x41]);
    const fixture = await startReviewServiceFixture((_request, response) => {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/octet-stream');
      response.end(artifactBytes);
    });
    try {
      const result = await runCliWithBufferedStdout([
        'artifact',
        'review_1',
        'json',
        '--service-url',
        fixture.url,
        '--service-token',
        'rat_test_secret',
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toEqual(artifactBytes);
      expect(result.stdout.toString('hex')).toBe('00ff41');
      expect(fixture.requests[0]?.url).toBe(
        '/v1/review/review_1/artifacts/json'
      );
    } finally {
      await fixture.close();
    }
  });

  it('sends cancel and publish requests with stable service command output', async () => {
    const fixture = await startReviewServiceFixture((request, response) => {
      if (request.url === '/v1/review/review_1/cancel') {
        writeJsonResponse(response, 202, {
          reviewId: 'review_1',
          status: 'running',
          cancelled: false,
        });
        return;
      }
      if (request.url === '/v1/review/review_1/publish') {
        writeJsonResponse(response, 200, {
          reviewId: 'review_1',
          status: 'published',
          publications: [],
        });
        return;
      }
      writeJsonResponse(response, 404, { error: 'not found' });
    });
    try {
      const cancel = await runCli([
        'cancel',
        'review_1',
        '--service-url',
        fixture.url,
        '--service-token',
        'rat_test_secret',
      ]);
      const publish = await runCli([
        'publish',
        'review_1',
        '--service-url',
        fixture.url,
        '--service-token',
        'rat_test_secret',
      ]);

      expect(cancel.status).toBe(0);
      expect(JSON.parse(cancel.stdout)).toEqual({
        reviewId: 'review_1',
        status: 'running',
        cancelled: false,
      });
      expect(publish.status).toBe(0);
      expect(JSON.parse(publish.stdout)).toEqual({
        reviewId: 'review_1',
        status: 'published',
        publications: [],
      });
      expect(fixture.requests.map((request) => request.method)).toEqual([
        'POST',
        'POST',
      ]);
      expect(fixture.requests.map((request) => request.url)).toEqual([
        '/v1/review/review_1/cancel',
        '/v1/review/review_1/publish',
      ]);
    } finally {
      await fixture.close();
    }
  });
});

describe('review-agent provider model routing', () => {
  it('rejects mismatched routed model prefixes before review execution', () => {
    const result = spawnSync(
      'tsx',
      [
        cliPath,
        'run',
        '--prompt',
        'review this',
        '--provider',
        'gateway',
        '--model',
        'openrouter:openai/gpt-5',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          AI_GATEWAY_API_KEY: 'test-gateway-key',
          OPENROUTER_API_KEY: 'test-openrouter-key',
        },
      }
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      '--provider gateway cannot use "openrouter:" model ids'
    );
  });
});
