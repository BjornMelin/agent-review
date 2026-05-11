use review_agent_contracts::{
    ContractParseError, JSON_SCHEMA_MANIFEST, parse_command_run_input, parse_command_run_output,
    parse_review_request, parse_review_result, parse_sandbox_audit,
};
use serde_json::{Number, Value, json};

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_set_version: u32,
    source: String,
    generator: String,
    schemas: Vec<ManifestEntry>,
}

#[derive(Debug, serde::Deserialize)]
struct ManifestEntry {
    name: String,
    file: String,
}

#[test]
fn schema_manifest_snapshot_matches_review_types() {
    let manifest: Manifest =
        serde_json::from_str(JSON_SCHEMA_MANIFEST).expect("schema manifest must parse");

    let snapshot = format!(
        "schemaSetVersion: {}\nsource: {}\ngenerator: {}\nschemas:\n{}",
        manifest.schema_set_version,
        manifest.source,
        manifest.generator,
        manifest
            .schemas
            .iter()
            .map(|entry| format!("  - {} -> {}", entry.name, entry.file))
            .collect::<Vec<_>>()
            .join("\n")
    );

    insta::assert_snapshot!("schema_manifest", snapshot);
}

#[test]
fn generated_review_request_dto_round_trips_boundary_json() {
    let input = json!({
        "cwd": "/tmp/repo",
        "target": { "type": "commit", "sha": "abc1234", "title": "change" },
        "provider": "codexDelegate",
        "executionMode": "remoteSandbox",
        "reasoningEffort": "high",
        "includePaths": ["packages/review-types"],
        "excludePaths": ["dist"],
        "maxFiles": 25,
        "maxDiffBytes": 65536,
        "outputFormats": ["json", "markdown"],
        "severityThreshold": "p1",
        "detached": true
    });

    let dto = parse_review_request(&input).expect("request DTO parses");

    assert_eq!(
        serde_json::to_value(dto).expect("request DTO serializes"),
        input
    );
}

#[test]
fn generated_review_result_dto_round_trips_sandbox_metadata() {
    let input = json!({
        "findings": [{
            "title": "Missing guard",
            "body": "The checked path can be absent.",
            "priority": 1,
            "confidenceScore": 0.92,
            "codeLocation": {
                "absoluteFilePath": "/tmp/repo/src/index.ts",
                "lineRange": { "start": 10, "end": 12 }
            },
            "fingerprint": "finding-1"
        }],
        "overallCorrectness": "patch is incorrect",
        "overallExplanation": "One blocking finding remains.",
        "overallConfidenceScore": 0.87,
        "metadata": {
            "provider": "openaiCompatible",
            "modelResolved": "gateway:gpt-5.5",
            "executionMode": "remoteSandbox",
            "promptPack": "default",
            "gitContext": {
                "mode": "custom",
                "baseRef": "main",
                "mergeBaseSha": "abc123",
                "commitSha": "def456"
            },
            "sandboxId": "sandbox-1"
        }
    });

    let dto = parse_review_result(&input).expect("result DTO parses");

    assert_eq!(
        normalize_value(serde_json::to_value(dto).expect("result DTO serializes")),
        normalize_value(input)
    );
}

#[test]
fn generated_sandbox_audit_dto_round_trips_command_phase() {
    let input = json!({
        "sandboxId": "sandbox-1",
        "policy": {
            "networkProfile": "deny_all",
            "allowlistDomains": [],
            "commandAllowlistSize": 1,
            "envAllowlistSize": 1
        },
        "consumed": {
            "commandCount": 1,
            "wallTimeMs": 20,
            "outputBytes": 42,
            "artifactBytes": 128
        },
        "redactions": {
            "apiKeyLike": 0,
            "bearer": 0
        },
        "commands": [{
            "commandId": "cmd-1",
            "cmd": "node",
            "args": ["review-runner.mjs"],
            "cwd": "/workspace",
            "phase": "runtime",
            "startedAtMs": 1,
            "endedAtMs": 21,
            "durationMs": 20,
            "outputBytes": 42,
            "redactions": {
                "apiKeyLike": 0,
                "bearer": 0
            },
            "exitCode": 0
        }]
    });

    let dto = parse_sandbox_audit(&input).expect("sandbox audit DTO parses");

    assert_eq!(
        normalize_value(serde_json::to_value(dto).expect("sandbox audit DTO serializes")),
        normalize_value(input)
    );
}

#[test]
fn generated_command_run_dtos_round_trip_runner_contracts() {
    let input = json!({
        "commandId": "codex-review",
        "cmd": "codex",
        "args": ["review", "--uncommitted"],
        "cwd": "/tmp/repo",
        "timeoutMs": 30000,
        "maxStdoutBytes": 1024,
        "maxStderrBytes": 1024,
        "maxFileBytes": 1024,
        "maxTotalFileBytes": 1024,
        "tempDirPrefix": "review-agent-codex-",
        "readFiles": [{
            "key": "lastMessage",
            "path": "{tempDir}/last-message.txt",
            "optional": true
        }]
    });
    let output = json!({
        "commandId": "codex-review",
        "cmd": "codex",
        "args": ["review", "--uncommitted"],
        "cwd": "/tmp/repo",
        "status": "completed",
        "exitCode": 0,
        "stdout": "",
        "stderr": "",
        "stdoutTruncated": false,
        "stderrTruncated": false,
        "startedAtMs": 1,
        "endedAtMs": 2,
        "durationMs": 1,
        "outputBytes": 0,
        "redactions": { "apiKeyLike": 0, "bearer": 0 },
        "events": [{
            "type": "started",
            "commandId": "codex-review",
            "timestampMs": 1
        }],
        "files": []
    });

    let input_dto = parse_command_run_input(&input).expect("command input DTO parses");
    let output_dto = parse_command_run_output(&output).expect("command output DTO parses");

    assert_eq!(
        serde_json::to_value(input_dto).expect("command input DTO serializes"),
        input
    );
    assert_eq!(
        serde_json::to_value(output_dto).expect("command output DTO serializes"),
        output
    );
}

#[test]
fn validated_review_request_rejects_schema_constraint_violations() {
    let invalid_request = json!({
        "cwd": "",
        "target": { "type": "uncommittedChanges" },
        "provider": "codexDelegate",
        "maxFiles": 0,
        "outputFormats": []
    });

    assert_invalid_json(parse_review_request(&invalid_request));
}

#[test]
fn validated_review_request_rejects_semantic_ref_and_path_violations() {
    for invalid_request in [
        json!({
            "cwd": "/tmp/repo",
            "target": { "type": "baseBranch", "branch": "main..HEAD" },
            "provider": "codexDelegate",
            "outputFormats": ["json"]
        }),
        json!({
            "cwd": "/tmp/repo",
            "target": { "type": "baseBranch", "branch": "main\u{00a0}HEAD" },
            "provider": "codexDelegate",
            "outputFormats": ["json"]
        }),
        json!({
            "cwd": "/tmp/repo",
            "target": { "type": "uncommittedChanges" },
            "provider": "codexDelegate",
            "includePaths": ["../secrets"],
            "outputFormats": ["json"]
        }),
        json!({
            "cwd": "/tmp/repo",
            "target": { "type": "uncommittedChanges" },
            "provider": "codexDelegate",
            "outputFormats": ["json", "json"]
        }),
    ] {
        assert_invalid_semantics(parse_review_request(&invalid_request));
    }
}

#[test]
fn validated_review_request_preserves_multiline_custom_prompts() {
    let request = json!({
        "cwd": "/tmp/repo",
        "target": { "type": "custom", "instructions": "line one\nline two\tok" },
        "provider": "codexDelegate",
        "executionMode": "localTrusted",
        "outputFormats": ["json"]
    });

    let dto = parse_review_request(&request).expect("multiline custom request parses");

    assert_eq!(
        serde_json::to_value(dto).expect("request DTO serializes"),
        request
    );
}

#[test]
fn validated_review_request_rejects_zod_byte_and_control_refinements() {
    let oversized_multibyte_prompt = "é".repeat(8200);
    for invalid_request in [
        json!({
            "cwd": "/tmp/repo",
            "target": { "type": "custom", "instructions": oversized_multibyte_prompt },
            "provider": "codexDelegate",
            "outputFormats": ["json"]
        }),
        json!({
            "cwd": "/tmp/repo",
            "target": { "type": "custom", "instructions": "line one\u{0000}line two" },
            "provider": "codexDelegate",
            "outputFormats": ["json"]
        }),
    ] {
        assert_invalid_semantics(parse_review_request(&invalid_request));
    }
}

#[test]
fn validated_review_result_rejects_out_of_range_values() {
    let invalid_result = json!({
        "findings": [{
            "title": "Missing guard",
            "body": "The checked path can be absent.",
            "confidenceScore": 1.5,
            "codeLocation": {
                "absoluteFilePath": "/tmp/repo/src/index.ts",
                "lineRange": { "start": 0, "end": 12 }
            },
            "fingerprint": "finding-1"
        }],
        "overallCorrectness": "patch is incorrect",
        "overallExplanation": "One blocking finding remains.",
        "overallConfidenceScore": 0.87,
        "metadata": {
            "provider": "openaiCompatible",
            "modelResolved": "gateway:gpt-5.5",
            "executionMode": "remoteSandbox",
            "promptPack": "default",
            "gitContext": { "mode": "custom" }
        }
    });

    assert_invalid_json(parse_review_result(&invalid_result));
}

#[test]
fn validated_review_result_rejects_zod_line_range_refinement() {
    let invalid_result = json!({
        "findings": [{
            "title": "Missing guard",
            "body": "The checked path can be absent.",
            "confidenceScore": 0.92,
            "codeLocation": {
                "absoluteFilePath": "/tmp/repo/src/index.ts",
                "lineRange": { "start": 10, "end": 2 }
            },
            "fingerprint": "finding-1"
        }],
        "overallCorrectness": "patch is incorrect",
        "overallExplanation": "One blocking finding remains.",
        "overallConfidenceScore": 0.87,
        "metadata": {
            "provider": "openaiCompatible",
            "modelResolved": "gateway:gpt-5.5",
            "executionMode": "remoteSandbox",
            "promptPack": "default",
            "gitContext": { "mode": "custom" }
        }
    });

    assert_invalid_semantics(parse_review_result(&invalid_result));
}

#[test]
fn validated_sandbox_audit_rejects_negative_counters() {
    let invalid_audit = json!({
        "sandboxId": "sandbox-1",
        "policy": {
            "networkProfile": "deny_all",
            "allowlistDomains": [],
            "commandAllowlistSize": -1,
            "envAllowlistSize": 1
        },
        "consumed": {
            "commandCount": 1,
            "wallTimeMs": 20,
            "outputBytes": -42,
            "artifactBytes": 128
        },
        "redactions": {
            "apiKeyLike": 0,
            "bearer": 0
        },
        "commands": []
    });

    assert_invalid_json(parse_sandbox_audit(&invalid_audit));
}

#[test]
fn explicit_empty_request_path_filters_round_trip_as_absent_defaults() {
    let input = json!({
        "cwd": "/tmp/repo",
        "target": { "type": "uncommittedChanges" },
        "provider": "codexDelegate",
        "includePaths": [],
        "excludePaths": [],
        "outputFormats": ["json"]
    });

    let dto = parse_review_request(&input).expect("request DTO parses");
    let serialized = serde_json::to_value(dto).expect("request DTO serializes");

    assert_eq!(serialized.get("includePaths"), None);
    assert_eq!(serialized.get("excludePaths"), None);
}

fn assert_invalid_json<T>(result: Result<T, ContractParseError>) {
    match result {
        Err(ContractParseError::InvalidJson { .. }) => {}
        Err(error) => panic!("expected JSON Schema validation error, got {error:?}"),
        Ok(_) => panic!("expected JSON Schema validation to reject value"),
    }
}

fn assert_invalid_semantics<T>(result: Result<T, ContractParseError>) {
    match result {
        Err(ContractParseError::InvalidSemantics { .. }) => {}
        Err(error) => panic!("expected semantic validation error, got {error:?}"),
        Ok(_) => panic!("expected semantic validation to reject value"),
    }
}

fn normalize_value(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, normalize_value(value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(normalize_value).collect()),
        Value::Number(number) => normalize_number(number),
        other => other,
    }
}

fn normalize_number(number: Number) -> Value {
    if let Some(float) = number.as_f64() {
        if float.fract() == 0.0 && float >= i64::MIN as f64 && float <= i64::MAX as f64 {
            return Value::Number(Number::from(float as i64));
        }
    }

    Value::Number(number)
}
