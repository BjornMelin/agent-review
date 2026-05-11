use std::error::Error;
use std::fmt;
use std::path::{Path, PathBuf};

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use review_agent_contracts::{ContractParseError, ReviewRequest, parse_review_request};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffChunk {
    pub file: String,
    pub absolute_file_path: String,
    pub patch: String,
    pub changed_lines: Vec<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiffIndexInput {
    pub request: Value,
    pub patch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffIndexOutput {
    pub patch: String,
    pub chunks: Vec<DiffChunk>,
    pub changed_line_index: Vec<(String, Vec<usize>)>,
}

#[derive(Debug)]
pub enum DiffIndexError {
    InvalidRequest(ContractParseError),
    InvalidGlob {
        pattern: String,
        source: globset::Error,
    },
    InvalidLimit {
        field: &'static str,
        value: i64,
    },
}

impl fmt::Display for DiffIndexError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(error) => write!(formatter, "invalid review request: {error}"),
            Self::InvalidGlob { pattern, source } => {
                write!(formatter, "invalid glob pattern {pattern:?}: {source}")
            }
            Self::InvalidLimit { field, value } => {
                write!(
                    formatter,
                    "{field} cannot be represented as a usize: {value}"
                )
            }
        }
    }
}

impl Error for DiffIndexError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidRequest(error) => Some(error),
            Self::InvalidGlob { source, .. } => Some(source),
            Self::InvalidLimit { .. } => None,
        }
    }
}

impl From<ContractParseError> for DiffIndexError {
    fn from(error: ContractParseError) -> Self {
        Self::InvalidRequest(error)
    }
}

fn decode_git_quoted_path(value: &str) -> String {
    let mut bytes = Vec::new();
    let mut chars = value.chars().peekable();
    while let Some(char) = chars.next() {
        if char != '\\' {
            let mut buffer = [0; 4];
            bytes.extend_from_slice(char.encode_utf8(&mut buffer).as_bytes());
            continue;
        }

        let Some(escape) = chars.next() else {
            bytes.push(b'\\');
            break;
        };
        match escape {
            '\\' => bytes.push(b'\\'),
            '"' => bytes.push(b'"'),
            'a' => bytes.push(0x07),
            'b' => bytes.push(0x08),
            'f' => bytes.push(0x0c),
            'n' => bytes.push(b'\n'),
            'r' => bytes.push(b'\r'),
            't' => bytes.push(b'\t'),
            'v' => bytes.push(0x0b),
            '0'..='7' => {
                let mut octal = String::from(escape);
                while octal.len() < 3 {
                    match chars.peek() {
                        Some(next) if matches!(next, '0'..='7') => {
                            octal.push(*next);
                            chars.next();
                        }
                        _ => break,
                    }
                }
                match u8::from_str_radix(&octal, 8) {
                    Ok(value) => bytes.push(value),
                    Err(_) => {
                        bytes.push(b'\\');
                        bytes.extend_from_slice(octal.as_bytes());
                    }
                }
            }
            other => {
                let mut buffer = [0; 4];
                bytes.extend_from_slice(other.encode_utf8(&mut buffer).as_bytes());
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn parse_quoted_git_path(input: &str, start: usize) -> Option<(String, usize)> {
    if input.as_bytes().get(start) != Some(&b'"') {
        return None;
    }

    let mut escaped = false;
    for index in start + 1..input.len() {
        let byte = input.as_bytes()[index];
        if escaped {
            escaped = false;
            continue;
        }
        if byte == b'\\' {
            escaped = true;
            continue;
        }
        if byte == b'"' {
            return Some((decode_git_quoted_path(&input[start + 1..index]), index + 1));
        }
    }

    None
}

fn parse_header_path(input: &str) -> String {
    let trimmed = input.trim();
    if let Some((quoted, _end)) = parse_quoted_git_path(trimmed, 0) {
        return quoted;
    }
    trimmed
        .split('\t')
        .next()
        .unwrap_or(trimmed)
        .trim_end()
        .to_owned()
}

fn strip_diff_side_prefix(path: &str) -> String {
    match path.strip_prefix("a/").or_else(|| path.strip_prefix("b/")) {
        Some(stripped) => stripped.to_owned(),
        None => path.to_owned(),
    }
}

fn parse_unquoted_diff_header_paths(input: &str) -> Option<(String, String)> {
    if !input.starts_with("a/") {
        return None;
    }

    let mut candidates = Vec::new();
    let mut search_start = 0usize;
    while let Some(relative_index) = input[search_start..].find(" b/") {
        let target_start = search_start + relative_index;
        candidates.push((
            input[2..target_start].to_owned(),
            input[target_start + 3..].to_owned(),
        ));
        search_start = target_start + 1;
    }

    candidates
        .iter()
        .find(|(source, target)| source == target)
        .cloned()
        .or_else(|| candidates.pop())
}

fn extract_path_from_diff_header(line: &str) -> Option<String> {
    let rest = line.strip_prefix("diff --git ")?;
    if rest.starts_with('"') {
        let (_source, source_end) = parse_quoted_git_path(rest, 0)?;
        return Some(strip_diff_side_prefix(&parse_header_path(
            &rest[source_end..],
        )));
    }

    parse_unquoted_diff_header_paths(rest).map(|(_source, target)| target)
}

fn extract_path_from_file_header(line: &str, prefix: &str) -> Option<String> {
    let candidate = parse_header_path(line.strip_prefix(prefix)?);
    if candidate == "/dev/null" {
        return None;
    }
    Some(strip_diff_side_prefix(&candidate))
}

fn extract_path_from_rename_header(line: &str) -> Option<String> {
    if let Some(candidate) = line.strip_prefix("rename to ") {
        return Some(parse_header_path(candidate));
    }
    if let Some(candidate) = line.strip_prefix("copy to ") {
        return Some(parse_header_path(candidate));
    }
    None
}

fn parse_hunk_target_start(line: &str) -> Option<usize> {
    if !line.starts_with("@@ -") {
        return None;
    }

    let plus_start = line.find(" +")? + 2;
    let digits: String = line[plus_start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse::<usize>().ok()
}

fn absolute_file_path(cwd: &Path, file: &str) -> String {
    let path = Path::new(file);
    let absolute = if path.is_absolute() {
        PathBuf::from(path)
    } else {
        cwd.join(path)
    };
    absolute.to_string_lossy().into_owned()
}

pub fn parse_unified_diff(cwd: &Path, patch: &str) -> Vec<DiffChunk> {
    if patch.trim().is_empty() {
        return Vec::new();
    }

    let mut chunks = Vec::new();
    let mut current_file = String::new();
    let mut current_patch: Vec<&str> = Vec::new();
    let mut changed_lines = Vec::new();
    let mut new_line_cursor = 0usize;
    let mut in_hunk = false;

    let mut flush =
        |current_file: &str, current_patch: &mut Vec<&str>, changed_lines: &mut Vec<usize>| {
            if current_file.is_empty() || current_patch.is_empty() {
                return;
            }
            changed_lines.sort_unstable();
            changed_lines.dedup();
            chunks.push(DiffChunk {
                file: current_file.to_owned(),
                absolute_file_path: absolute_file_path(cwd, current_file),
                patch: current_patch.join("\n"),
                changed_lines: std::mem::take(changed_lines),
            });
        };

    for line in patch.split('\n') {
        if line.starts_with("diff --git ") {
            flush(&current_file, &mut current_patch, &mut changed_lines);
            current_patch = vec![line];
            changed_lines = Vec::new();
            in_hunk = false;
            new_line_cursor = 0;
            current_file = extract_path_from_diff_header(line).unwrap_or_default();
            continue;
        }

        if current_patch.is_empty() {
            continue;
        }

        current_patch.push(line);
        if let Some(minus_header_path) = extract_path_from_file_header(line, "--- ") {
            current_file = minus_header_path;
        }
        if let Some(plus_header_path) = extract_path_from_file_header(line, "+++ ") {
            current_file = plus_header_path;
        }
        if let Some(rename_header_path) = extract_path_from_rename_header(line) {
            current_file = rename_header_path;
        }

        if let Some(target_start) = parse_hunk_target_start(line) {
            new_line_cursor = target_start;
            in_hunk = true;
            continue;
        }

        if !in_hunk {
            continue;
        }

        if line.starts_with('+') && !line.starts_with("+++") {
            changed_lines.push(new_line_cursor);
            new_line_cursor += 1;
            continue;
        }

        if line.starts_with('-') && !line.starts_with("---") {
            continue;
        }

        if line.starts_with(' ') {
            new_line_cursor += 1;
            continue;
        }

        if line.starts_with("\\ No newline at end of file") {
            continue;
        }

        if line.is_empty() {
            continue;
        }

        in_hunk = false;
    }

    flush(&current_file, &mut current_patch, &mut changed_lines);
    chunks
}

fn build_glob_set(patterns: &[String]) -> Result<Option<GlobSet>, DiffIndexError> {
    if patterns.is_empty() {
        return Ok(None);
    }

    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let glob = GlobBuilder::new(pattern)
            .literal_separator(true)
            .empty_alternates(true)
            .allow_unclosed_class(true)
            .build()
            .map_err(|source| DiffIndexError::InvalidGlob {
                pattern: pattern.clone(),
                source,
            })?;
        builder.add(glob);
    }
    builder
        .build()
        .map(Some)
        .map_err(|source| DiffIndexError::InvalidGlob {
            pattern: patterns.join(", "),
            source,
        })
}

fn optional_usize_limit(
    value: Option<i64>,
    field: &'static str,
) -> Result<Option<usize>, DiffIndexError> {
    value
        .map(|limit| {
            usize::try_from(limit).map_err(|_error| DiffIndexError::InvalidLimit {
                field,
                value: limit,
            })
        })
        .transpose()
}

fn chunk_matches_filters(
    chunk: &DiffChunk,
    include_paths: &Option<GlobSet>,
    exclude_paths: &Option<GlobSet>,
) -> bool {
    if let Some(include_paths) = include_paths {
        if !include_paths.is_match(&chunk.file) {
            return false;
        }
    }

    if let Some(exclude_paths) = exclude_paths {
        if exclude_paths.is_match(&chunk.file) {
            return false;
        }
    }

    true
}

fn push_changed_line_index(
    index: &mut Vec<(String, Vec<usize>)>,
    absolute_file_path: &str,
    changed_lines: &[usize],
) {
    let lines = match index
        .iter_mut()
        .find(|(candidate, _lines)| candidate == absolute_file_path)
    {
        Some((_path, lines)) => lines,
        None => {
            index.push((absolute_file_path.to_owned(), Vec::new()));
            &mut index.last_mut().expect("index entry exists").1
        }
    };
    lines.extend(changed_lines.iter().copied());
    lines.sort_unstable();
    lines.dedup();
}

fn build_changed_line_index(chunks: &[DiffChunk]) -> Vec<(String, Vec<usize>)> {
    let mut index = Vec::new();
    for chunk in chunks {
        push_changed_line_index(&mut index, &chunk.absolute_file_path, &chunk.changed_lines);
    }
    index
}

pub fn build_diff_index(
    request: &ReviewRequest,
    patch: &str,
) -> Result<DiffIndexOutput, DiffIndexError> {
    let include_paths = build_glob_set(&request.include_paths)?;
    let exclude_paths = build_glob_set(&request.exclude_paths)?;
    let max_files = optional_usize_limit(request.max_files, "maxFiles")?;
    let max_diff_bytes = optional_usize_limit(request.max_diff_bytes, "maxDiffBytes")?;

    let mut filtered_chunks = Vec::new();
    let mut total_bytes = 0usize;
    for chunk in parse_unified_diff(Path::new(&request.cwd), patch) {
        if !chunk_matches_filters(&chunk, &include_paths, &exclude_paths) {
            continue;
        }
        if max_files.is_some_and(|limit| filtered_chunks.len() >= limit) {
            break;
        }

        let chunk_bytes = chunk.patch.len();
        if max_diff_bytes.is_some_and(|limit| total_bytes + chunk_bytes > limit) {
            break;
        }

        total_bytes += chunk_bytes;
        filtered_chunks.push(chunk);
    }

    Ok(DiffIndexOutput {
        patch: filtered_chunks
            .iter()
            .map(|chunk| chunk.patch.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        changed_line_index: build_changed_line_index(&filtered_chunks),
        chunks: filtered_chunks,
    })
}

pub fn build_diff_index_from_input(
    input: DiffIndexInput,
) -> Result<DiffIndexOutput, DiffIndexError> {
    let request = parse_review_request(&input.request)?;
    build_diff_index(&request, &input.patch)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;

    use super::{DiffIndexInput, build_diff_index_from_input, parse_unified_diff};

    #[test]
    fn parses_quoted_paths_and_added_lines() {
        let patch = concat!(
            "diff --git \"a/quoted\\tpath.ts\" \"b/quoted\\tpath.ts\"\n",
            "index 7898192..6178079 100644\n",
            "--- \"a/quoted\\tpath.ts\"\n",
            "+++ \"b/quoted\\tpath.ts\"\n",
            "@@ -1 +1 @@\n",
            "-a\n",
            "+b\n",
        );

        let chunks = parse_unified_diff(Path::new("/repo"), patch);

        assert_eq!(chunks[0].file, "quoted\tpath.ts");
        assert_eq!(chunks[0].absolute_file_path, "/repo/quoted\tpath.ts");
        assert_eq!(chunks[0].changed_lines, vec![1]);
    }

    #[test]
    fn filters_and_indexes_chunks_with_generated_review_request() {
        let patch = [
            "diff --git a/src/app.ts b/src/app.ts",
            "index 7898192..6178079 100644",
            "--- a/src/app.ts",
            "+++ b/src/app.ts",
            "@@ -1 +1 @@",
            "-export const app = 1;",
            "+export const app = 2;",
            "diff --git a/src/generated/client.ts b/src/generated/client.ts",
            "index 7898192..6178079 100644",
            "--- a/src/generated/client.ts",
            "+++ b/src/generated/client.ts",
            "@@ -1 +1 @@",
            "-export const generated = 1;",
            "+export const generated = 2;",
        ]
        .join("\n");
        let request = json!({
            "cwd": "/repo",
            "target": { "type": "uncommittedChanges" },
            "provider": "codexDelegate",
            "includePaths": ["src/**"],
            "excludePaths": ["src/generated/**"],
            "outputFormats": ["json"]
        });

        let output = build_diff_index_from_input(DiffIndexInput { request, patch }).unwrap();

        assert_eq!(output.chunks.len(), 1);
        assert_eq!(output.chunks[0].file, "src/app.ts");
        assert_eq!(
            output.changed_line_index,
            vec![("/repo/src/app.ts".to_owned(), vec![1])]
        );
    }

    #[test]
    fn applies_file_and_byte_limits_after_path_filters() {
        let patch = [
            "diff --git a/src/one.ts b/src/one.ts",
            "index 7898192..6178079 100644",
            "--- a/src/one.ts",
            "+++ b/src/one.ts",
            "@@ -1 +1 @@",
            "-export const one = 1;",
            "+export const one = 2;",
            "diff --git a/src/two.ts b/src/two.ts",
            "index 7898192..6178079 100644",
            "--- a/src/two.ts",
            "+++ b/src/two.ts",
            "@@ -1 +1 @@",
            "-export const two = 1;",
            "+export const two = 2;",
        ]
        .join("\n");
        let request = json!({
            "cwd": "/repo",
            "target": { "type": "uncommittedChanges" },
            "provider": "codexDelegate",
            "includePaths": ["src/**"],
            "maxFiles": 1,
            "maxDiffBytes": 1024,
            "outputFormats": ["json"]
        });

        let output = build_diff_index_from_input(DiffIndexInput { request, patch }).unwrap();

        assert_eq!(
            output
                .chunks
                .iter()
                .map(|chunk| chunk.file.as_str())
                .collect::<Vec<_>>(),
            vec!["src/one.ts"]
        );
        assert!(!output.patch.contains("src/two.ts"));
    }

    #[test]
    fn includes_dot_paths_with_minimatch_dot_semantics() {
        let patch = [
            "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
            "index 7898192..6178079 100644",
            "--- a/.github/workflows/ci.yml",
            "+++ b/.github/workflows/ci.yml",
            "@@ -1 +1 @@",
            "-name: old",
            "+name: new",
        ]
        .join("\n");
        let request = json!({
            "cwd": "/repo",
            "target": { "type": "uncommittedChanges" },
            "provider": "codexDelegate",
            "includePaths": [".github/**"],
            "outputFormats": ["json"]
        });

        let output = build_diff_index_from_input(DiffIndexInput { request, patch }).unwrap();

        assert_eq!(output.chunks[0].file, ".github/workflows/ci.yml");
    }
}
