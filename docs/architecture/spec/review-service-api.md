# Review Service API

Service package: `@review-agent/review-service`  
Default bind: `PORT=3042`

Base path: `/v1/review`

## Status Model

Defined by `ReviewRunStatusSchema` in `@review-agent/review-types`.

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`

## `POST /v1/review/start`

Starts a review.

### Request Body

```json
{
  "request": {
    "cwd": "/absolute/path",
    "target": { "type": "uncommittedChanges" },
    "provider": "codexDelegate",
    "executionMode": "localTrusted",
    "outputFormats": ["json", "markdown"]
  },
  "delivery": "inline"
}
```

- `request`: required `ReviewRequest`
- `delivery`: optional `inline|detached` (default `inline`)

Detached mode is active when `delivery=detached` or `request.detached=true`.
The request body is parsed by `ReviewStartRequestSchema`.

### Responses

- `200`: inline run finished; response includes `result` summary payload
- `202`: detached accepted; response includes `detachedRunId`
- `400`: request parse/validation or startup error

## `GET /v1/review/:reviewId`

Returns review status and result summary when available.

### Response Fields

- `reviewId`
- `status`
- `error` (optional)
- `result` (optional review result payload)
- `createdAt`
- `updatedAt`

Returns `404` when review ID is unknown.
The response body follows `ReviewStatusResponseSchema`.

## `GET /v1/review/:reviewId/events`

Server-Sent Events stream of lifecycle events.

### Behavior

- Replays historical events first.
- Streams live events while connection remains open.
- Sends heartbeat comments every 15 seconds (`: keepalive`).
- Event payload shape follows `LifecycleEvent`, including `meta.correlation.reviewId` and event IDs/timestamps.

Returns `404` when review ID is unknown.

## `POST /v1/review/:reviewId/cancel`

Attempts cancellation of detached run.

### Responses

- `200`: cancellation applied, status becomes `cancelled`
- `404`: review not found
- `409`: cancellation not possible (e.g., no detached run or terminal state reached)

## `GET /v1/review/:reviewId/artifacts/:format`

Fetches generated artifact string for a completed review run.

### Supported `:format`

- `sarif`
- `json`
- `markdown`

### Content Types

- `markdown`: `text/markdown; charset=utf-8`
- `sarif`/`json`: `application/json; charset=utf-8`

Returns:

- `404` when review/result/artifact is unavailable.
- `400` when `:format` does not parse through `OutputFormatSchema`.

## Notes and Constraints

- Service state is in-memory only.
- No authentication layer is currently implemented.
- `remoteSandbox` execution mode is currently rejected with `400`.
- Service error bodies follow `ReviewErrorResponseSchema`.
