//! Rust DTOs generated from the canonical TypeScript review schemas.
//!
//! `packages/review-types` owns the Zod contracts. This crate only proves that
//! the emitted JSON Schema artifacts can be consumed from Rust without
//! hand-written duplicate structs. Generated DTOs are shape types; callers that
//! accept untrusted JSON must use the parser helpers so the committed JSON
//! Schema constraints and explicit Zod refinements are checked before Serde
//! constructs a DTO.

#![forbid(unsafe_code)]

use std::{error::Error, fmt, sync::OnceLock};

use serde::de::DeserializeOwned;
use serde_json::Value;

/// Generated DTOs from `packages/review-types/generated/json-schema`.
pub mod generated {
    #![allow(clippy::all)]
    include!(concat!(env!("OUT_DIR"), "/contracts.rs"));
}

/// Re-exported generated DTOs from the committed `review-types` JSON Schema set.
pub use generated::*;

/// Committed JSON Schema manifest consumed by the Rust contract generator.
pub const JSON_SCHEMA_MANIFEST: &str =
    include_str!("../../../packages/review-types/generated/json-schema/manifest.json");

const REVIEW_REQUEST_SCHEMA: &str =
    include_str!("../../../packages/review-types/generated/json-schema/review-request.schema.json");
const REVIEW_RESULT_SCHEMA: &str =
    include_str!("../../../packages/review-types/generated/json-schema/review-result.schema.json");
const COMMAND_RUN_INPUT_SCHEMA: &str = include_str!(
    "../../../packages/review-types/generated/json-schema/command-run-input.schema.json"
);
const COMMAND_RUN_OUTPUT_SCHEMA: &str = include_str!(
    "../../../packages/review-types/generated/json-schema/command-run-output.schema.json"
);
const SANDBOX_AUDIT_SCHEMA: &str =
    include_str!("../../../packages/review-types/generated/json-schema/sandbox-audit.schema.json");

const MAX_CWD_BYTES: usize = 4096;
const MAX_CUSTOM_INSTRUCTIONS_BYTES: usize = 16 * 1024;
const MAX_GIT_REF_BYTES: usize = 256;
const MAX_COMMIT_TITLE_BYTES: usize = 512;
const MAX_MODEL_BYTES: usize = 256;
const MAX_PATH_FILTER_BYTES: usize = 256;

static REVIEW_REQUEST_VALIDATOR: OnceLock<Result<jsonschema::Validator, String>> = OnceLock::new();
static REVIEW_RESULT_VALIDATOR: OnceLock<Result<jsonschema::Validator, String>> = OnceLock::new();
static COMMAND_RUN_INPUT_VALIDATOR: OnceLock<Result<jsonschema::Validator, String>> =
    OnceLock::new();
static COMMAND_RUN_OUTPUT_VALIDATOR: OnceLock<Result<jsonschema::Validator, String>> =
    OnceLock::new();
static SANDBOX_AUDIT_VALIDATOR: OnceLock<Result<jsonschema::Validator, String>> = OnceLock::new();

/// Contract parsing error raised before a generated DTO crosses the Rust boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContractParseError {
    /// The embedded JSON Schema artifact could not be parsed or compiled.
    InvalidSchema {
        /// Human-readable schema name.
        schema: &'static str,
        /// Parser or compiler diagnostic.
        message: String,
    },
    /// Input JSON failed validation against the committed schema artifact.
    InvalidJson {
        /// Human-readable schema name.
        schema: &'static str,
        /// JSON Schema validation diagnostic.
        message: String,
    },
    /// Schema-valid JSON failed Serde deserialization into the generated DTO.
    InvalidShape {
        /// Human-readable schema name.
        schema: &'static str,
        /// Serde deserialization diagnostic.
        message: String,
    },
    /// Input JSON failed an explicit semantic guard for a Zod refinement.
    InvalidSemantics {
        /// Human-readable schema name.
        schema: &'static str,
        /// Semantic validation diagnostic.
        message: String,
    },
}

impl fmt::Display for ContractParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSchema { schema, message } => {
                write!(formatter, "{schema} schema is invalid: {message}")
            }
            Self::InvalidJson { schema, message } => {
                write!(formatter, "{schema} JSON is invalid: {message}")
            }
            Self::InvalidShape { schema, message } => {
                write!(formatter, "{schema} DTO shape is invalid: {message}")
            }
            Self::InvalidSemantics { schema, message } => {
                write!(formatter, "{schema} semantics are invalid: {message}")
            }
        }
    }
}

impl Error for ContractParseError {}

/// Validate and parse a `ReviewRequest` JSON value through the committed schema.
pub fn parse_review_request(input: &Value) -> Result<ReviewRequest, ContractParseError> {
    let request = parse_contract(
        "ReviewRequest",
        REVIEW_REQUEST_SCHEMA,
        &REVIEW_REQUEST_VALIDATOR,
        input,
    )?;
    validate_review_request_semantics(input)?;
    Ok(request)
}

/// Validate and parse a `ReviewResult` JSON value through the committed schema.
pub fn parse_review_result(input: &Value) -> Result<ReviewResult, ContractParseError> {
    let result = parse_contract(
        "ReviewResult",
        REVIEW_RESULT_SCHEMA,
        &REVIEW_RESULT_VALIDATOR,
        input,
    )?;
    validate_review_result_semantics(&result)?;
    Ok(result)
}

/// Validate and parse a `CommandRunInput` JSON value through the committed schema.
pub fn parse_command_run_input(input: &Value) -> Result<CommandRunInput, ContractParseError> {
    parse_contract(
        "CommandRunInput",
        COMMAND_RUN_INPUT_SCHEMA,
        &COMMAND_RUN_INPUT_VALIDATOR,
        input,
    )
}

/// Validate and parse a `CommandRunOutput` JSON value through the committed schema.
pub fn parse_command_run_output(input: &Value) -> Result<CommandRunOutput, ContractParseError> {
    parse_contract(
        "CommandRunOutput",
        COMMAND_RUN_OUTPUT_SCHEMA,
        &COMMAND_RUN_OUTPUT_VALIDATOR,
        input,
    )
}

/// Validate and parse a `SandboxAudit` JSON value through the committed schema.
pub fn parse_sandbox_audit(input: &Value) -> Result<SandboxAudit, ContractParseError> {
    parse_contract(
        "SandboxAudit",
        SANDBOX_AUDIT_SCHEMA,
        &SANDBOX_AUDIT_VALIDATOR,
        input,
    )
}

fn parse_contract<T>(
    schema_name: &'static str,
    schema_json: &'static str,
    validator_cache: &'static OnceLock<Result<jsonschema::Validator, String>>,
    input: &Value,
) -> Result<T, ContractParseError>
where
    T: DeserializeOwned,
{
    let validator = schema_validator(schema_name, schema_json, validator_cache)?;
    validator
        .validate(input)
        .map_err(|error| ContractParseError::InvalidJson {
            schema: schema_name,
            message: error.to_string(),
        })?;

    // parse_contract accepts &Value for caller flexibility; input.clone() is
    // intentional because serde_json::from_value consumes its Value.
    serde_json::from_value(input.clone()).map_err(|error| ContractParseError::InvalidShape {
        schema: schema_name,
        message: error.to_string(),
    })
}

fn schema_validator(
    schema_name: &'static str,
    schema_json: &'static str,
    validator_cache: &'static OnceLock<Result<jsonschema::Validator, String>>,
) -> Result<&'static jsonschema::Validator, ContractParseError> {
    let compiled = validator_cache.get_or_init(|| {
        let schema_value =
            serde_json::from_str::<Value>(schema_json).map_err(|error| error.to_string())?;

        jsonschema::validator_for(&schema_value).map_err(|error| error.to_string())
    });

    match compiled {
        Ok(validator) => Ok(validator),
        Err(message) => Err(ContractParseError::InvalidSchema {
            schema: schema_name,
            message: message.clone(),
        }),
    }
}

fn validate_review_request_semantics(input: &Value) -> Result<(), ContractParseError> {
    validate_string_field(input.get("cwd"), "cwd", MAX_CWD_BYTES, false)?;
    validate_string_field(input.get("model"), "model", MAX_MODEL_BYTES, false)?;

    if let Some(target) = input.get("target").and_then(Value::as_object) {
        match target.get("type").and_then(Value::as_str) {
            Some("baseBranch") => {
                let branch = target.get("branch").and_then(Value::as_str).unwrap_or("");
                validate_git_ref(branch, "target.branch")?;
            }
            Some("commit") => {
                validate_string_field(target.get("sha"), "target.sha", MAX_GIT_REF_BYTES, false)?;
                validate_string_field(
                    target.get("title"),
                    "target.title",
                    MAX_COMMIT_TITLE_BYTES,
                    false,
                )?;
            }
            Some("custom") => validate_string_field(
                target.get("instructions"),
                "target.instructions",
                MAX_CUSTOM_INSTRUCTIONS_BYTES,
                true,
            )?,
            _ => {}
        }
    }

    validate_path_filters(input.get("includePaths"), "includePaths")?;
    validate_path_filters(input.get("excludePaths"), "excludePaths")?;
    validate_unique_output_formats(input)?;
    Ok(())
}

fn validate_unique_output_formats(input: &Value) -> Result<(), ContractParseError> {
    let Some(formats) = input.get("outputFormats").and_then(Value::as_array) else {
        return Ok(());
    };
    let mut seen = std::collections::HashSet::new();
    for format in formats.iter().filter_map(Value::as_str) {
        if !seen.insert(format) {
            return Err(ContractParseError::InvalidSemantics {
                schema: "ReviewRequest",
                message: "outputFormats must not contain duplicates".to_owned(),
            });
        }
    }
    Ok(())
}

fn validate_string_field(
    value: Option<&Value>,
    label: &str,
    max_bytes: usize,
    allow_multiline: bool,
) -> Result<(), ContractParseError> {
    let Some(text) = value.and_then(Value::as_str) else {
        return Ok(());
    };
    validate_string_value(text, label, max_bytes, allow_multiline)
}

fn validate_string_value(
    value: &str,
    label: &str,
    max_bytes: usize,
    allow_multiline: bool,
) -> Result<(), ContractParseError> {
    if value.len() > max_bytes {
        return Err(ContractParseError::InvalidSemantics {
            schema: "ReviewRequest",
            message: format!("{label} must be <= {max_bytes} UTF-8 bytes"),
        });
    }
    if value.chars().any(|character| {
        if allow_multiline && matches!(character, '\n' | '\r' | '\t') {
            return false;
        }
        let code_point = character as u32;
        code_point <= 0x1f || code_point == 0x7f
    }) {
        return Err(ContractParseError::InvalidSemantics {
            schema: "ReviewRequest",
            message: if allow_multiline {
                format!("{label} must not contain control characters other than tab or newline")
            } else {
                format!("{label} must not contain control characters")
            },
        });
    }
    Ok(())
}

fn validate_git_ref(value: &str, label: &str) -> Result<(), ContractParseError> {
    validate_string_value(value, label, MAX_GIT_REF_BYTES, false)?;
    let segments = value.split('/').collect::<Vec<_>>();
    let invalid = value.starts_with('-')
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains("..")
        || value.contains("@{")
        || value == "@"
        || value.ends_with('.')
        || segments
            .iter()
            .any(|segment| segment.starts_with('.') || segment.ends_with(".lock"))
        || value.contains("//")
        || value
            .chars()
            .any(|character| character.is_whitespace() || "~^:?*[\\".contains(character));
    if invalid {
        return Err(ContractParseError::InvalidSemantics {
            schema: "ReviewRequest",
            message: format!("{label} must be a simple Git ref name"),
        });
    }
    Ok(())
}

fn validate_path_filters(value: Option<&Value>, label: &str) -> Result<(), ContractParseError> {
    let Some(filters) = value.and_then(Value::as_array) else {
        return Ok(());
    };
    for (index, filter) in filters.iter().filter_map(Value::as_str).enumerate() {
        let item_label = format!("{label}[{index}]");
        validate_string_value(filter, &item_label, MAX_PATH_FILTER_BYTES, false)?;
        let segments = filter.split('/').collect::<Vec<_>>();
        let invalid = filter.starts_with('/')
            || filter.starts_with('~')
            || filter.starts_with('!')
            || filter.starts_with(":(")
            || filter.contains('\\')
            || filter.contains("//")
            || filter == "."
            || segments.contains(&"..");
        if invalid {
            return Err(ContractParseError::InvalidSemantics {
                schema: "ReviewRequest",
                message: format!("{item_label} must be a repository-relative path filter"),
            });
        }
    }
    Ok(())
}

fn validate_review_result_semantics(result: &ReviewResult) -> Result<(), ContractParseError> {
    for (index, finding) in result.findings.iter().enumerate() {
        let line_range = &finding.code_location.line_range;
        if line_range.end < line_range.start {
            return Err(ContractParseError::InvalidSemantics {
                schema: "ReviewResult",
                message: format!("findings[{index}].codeLocation.lineRange.end must be >= start"),
            });
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parser_helpers_reuse_compiled_validators() {
        let request = json!({
            "cwd": "/tmp/repo",
            "target": { "type": "uncommittedChanges" },
            "provider": "codexDelegate",
            "outputFormats": ["json"]
        });

        parse_review_request(&request).expect("request parses");
        let first = request_validator_ref();

        parse_review_request(&request).expect("request parses again");
        let second = request_validator_ref();

        assert!(std::ptr::eq(first, second));
    }

    fn request_validator_ref() -> &'static jsonschema::Validator {
        REVIEW_REQUEST_VALIDATOR
            .get()
            .and_then(|result| result.as_ref().ok())
            .expect("request validator must be compiled")
    }
}
