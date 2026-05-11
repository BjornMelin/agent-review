#![forbid(unsafe_code)]

use std::{
    collections::HashMap,
    error::Error,
    fmt, fs,
    io::Read,
    path::Path,
    process::{ExitStatus, Stdio},
    sync::OnceLock,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use command_group::{AsyncCommandGroup, AsyncGroupChild};
#[cfg(unix)]
use command_group::{Signal, UnixChildExt};
use regex::Regex;
use review_agent_contracts::{CommandRunInput, parse_command_run_input, parse_command_run_output};
use serde::Serialize;
use serde_json::Value;
use tempfile::TempDir;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::sleep,
};
use tokio_util::sync::CancellationToken;

const TEMP_DIR_PLACEHOLDER: &str = "{tempDir}";
const DEFAULT_TIMEOUT_MS: u64 = 5 * 60_000;
const DEFAULT_MAX_STREAM_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_FILE_BYTES: usize = 16 * 1024 * 1024;
const POLL_INTERVAL_MS: u64 = 10;
const GRACEFUL_SHUTDOWN_MS: u64 = 1_000;

#[derive(Debug)]
pub enum RunnerError {
    Contract(String),
    Io(String),
    InvalidInput(String),
}

impl fmt::Display for RunnerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Contract(message) => write!(formatter, "contract error: {message}"),
            Self::Io(message) => write!(formatter, "io error: {message}"),
            Self::InvalidInput(message) => write!(formatter, "invalid input: {message}"),
        }
    }
}

impl Error for RunnerError {}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Redactions {
    api_key_like: usize,
    bearer: usize,
}

impl Redactions {
    fn add(&mut self, other: Self) {
        self.api_key_like += other.api_key_like;
        self.bearer += other.bearer;
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerEvent {
    #[serde(rename = "type")]
    type_: &'static str,
    command_id: String,
    timestamp_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerFile {
    key: String,
    path: String,
    content: String,
    byte_length: usize,
    truncated: bool,
    redactions: Redactions,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerOutput {
    command_id: String,
    cmd: String,
    args: Vec<String>,
    cwd: String,
    status: &'static str,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    stdout_truncated: bool,
    stderr_truncated: bool,
    started_at_ms: u64,
    ended_at_ms: u64,
    duration_ms: u64,
    output_bytes: usize,
    redactions: Redactions,
    events: Vec<RunnerEvent>,
    files: Vec<RunnerFile>,
}

struct CapturedStream {
    text: String,
    byte_length: usize,
    truncated: bool,
}

struct PreparedCommand {
    cmd: String,
    args: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    read_files: Vec<PreparedReadFile>,
    temp_dir: Option<TempDir>,
}

struct PreparedReadFile {
    key: String,
    path: String,
    optional: bool,
}

/// Runs one command request from a JSON value and returns schema-valid JSON output.
pub async fn run_command_value(input: Value) -> Result<Value, RunnerError> {
    let command = parse_command_run_input(&input)
        .map_err(|error| RunnerError::Contract(error.to_string()))?;
    let output = run_command(command).await?;
    let value = serde_json::to_value(output).map_err(|error| RunnerError::Io(error.to_string()))?;
    parse_command_run_output(&value).map_err(|error| RunnerError::Contract(error.to_string()))?;
    Ok(value)
}

async fn run_command(input: CommandRunInput) -> Result<RunnerOutput, RunnerError> {
    let command_id = input
        .command_id
        .clone()
        .unwrap_or_else(|| format!("command-{}", now_ms()));
    let requested_cmd = input.cmd.clone();
    let requested_args = input.args.clone();
    let started_at_ms = now_ms();
    let started_at = Instant::now();
    let mut events = Vec::new();
    let timeout_ms = positive_ms(input.timeout_ms, DEFAULT_TIMEOUT_MS)?;
    let max_stdout_bytes = positive_usize(input.max_stdout_bytes, DEFAULT_MAX_STREAM_BYTES)?;
    let max_stderr_bytes = positive_usize(input.max_stderr_bytes, DEFAULT_MAX_STREAM_BYTES)?;
    let max_file_bytes = positive_usize(input.max_file_bytes, DEFAULT_MAX_FILE_BYTES)?;
    let max_total_file_bytes =
        positive_usize(input.max_total_file_bytes, DEFAULT_MAX_TOTAL_FILE_BYTES)?;
    let timeout_at = started_at + Duration::from_millis(timeout_ms);
    let limit_token = CancellationToken::new();
    let cancel_token = CancellationToken::new();
    let signal_token = CancellationToken::new();
    spawn_signal_cancellation(signal_token.clone());

    if let Some(cancel_after_ms) = input.cancel_after_ms {
        let cancel_after = positive_ms(Some(cancel_after_ms), DEFAULT_TIMEOUT_MS)?;
        let token = cancel_token.child_token();
        tokio::spawn(async move {
            sleep(Duration::from_millis(cancel_after)).await;
            token.cancel();
        });
    }

    let prepared = match prepare_command(&input) {
        Ok(prepared) => prepared,
        Err(error) => {
            return Ok(failed_to_start_output(
                command_id,
                requested_cmd,
                requested_args,
                input.cwd,
                started_at_ms,
                error.to_string(),
                events,
            ));
        }
    };
    let cwd = prepared.cwd.clone();
    let mut command = Command::new(&prepared.cmd);
    command
        .args(&prepared.args)
        .current_dir(&prepared.cwd)
        .env_clear()
        .stdin(if input.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in &prepared.env {
        command.env(key, value);
    }

    let mut child = match command.group().kill_on_drop(true).spawn() {
        Ok(child) => child,
        Err(error) => {
            cleanup_temp_dir(prepared.temp_dir, &command_id, &mut events);
            return Ok(failed_to_start_output(
                command_id,
                requested_cmd,
                requested_args,
                cwd,
                started_at_ms,
                error.to_string(),
                events,
            ));
        }
    };

    events.push(event(&command_id, "started", None));

    if let Some(stdin) = input.stdin {
        if let Some(mut child_stdin) = child.inner().stdin.take() {
            tokio::spawn(async move {
                let _ = child_stdin.write_all(stdin.as_bytes()).await;
            });
        }
    }

    let stdout = child
        .inner()
        .stdout
        .take()
        .ok_or_else(|| RunnerError::Io("child stdout was not piped".to_owned()))?;
    let stderr = child
        .inner()
        .stderr
        .take()
        .ok_or_else(|| RunnerError::Io("child stderr was not piped".to_owned()))?;
    let stdout_reader = tokio::spawn(read_limited(stdout, max_stdout_bytes, limit_token.clone()));
    let stderr_reader = tokio::spawn(read_limited(stderr, max_stderr_bytes, limit_token.clone()));

    let mut status = "completed";
    let mut killed = false;
    let exit_status = loop {
        if let Some(exit_status) = child
            .try_wait()
            .map_err(|error| RunnerError::Io(error.to_string()))?
        {
            break exit_status;
        }
        if Instant::now() >= timeout_at {
            status = "timedOut";
            events.push(event(&command_id, "timedOut", None));
            request_graceful_shutdown(&mut child);
            killed = true;
        } else if limit_token.is_cancelled() {
            status = "outputLimitExceeded";
            request_graceful_shutdown(&mut child);
            killed = true;
        } else if cancel_token.is_cancelled() {
            status = "cancelled";
            events.push(event(&command_id, "cancelled", None));
            request_graceful_shutdown(&mut child);
            killed = true;
        } else if signal_token.is_cancelled() {
            status = "cancelled";
            events.push(event(
                &command_id,
                "cancelled",
                Some("received termination signal".to_owned()),
            ));
            request_graceful_shutdown(&mut child);
            killed = true;
        }

        if killed {
            break wait_after_graceful_shutdown(&mut child).await?;
        } else {
            sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
            continue;
        };
    };

    let stdout = stdout_reader
        .await
        .map_err(|error| RunnerError::Io(error.to_string()))??;
    let stderr = stderr_reader
        .await
        .map_err(|error| RunnerError::Io(error.to_string()))??;
    let mut redactions = Redactions::default();
    let (stdout_sanitized, stdout_sanitized_truncated) =
        redact_and_cap_secrets(&stdout.text, max_stdout_bytes);
    let (stderr_sanitized, stderr_sanitized_truncated) =
        redact_and_cap_secrets(&stderr.text, max_stderr_bytes);
    if stdout.truncated || stdout_sanitized_truncated {
        events.push(event(&command_id, "stdoutLimitExceeded", None));
    }
    if stderr.truncated || stderr_sanitized_truncated {
        events.push(event(&command_id, "stderrLimitExceeded", None));
    }
    if status == "completed"
        && (stdout.truncated
            || stderr.truncated
            || stdout_sanitized_truncated
            || stderr_sanitized_truncated)
    {
        status = "outputLimitExceeded";
    }

    let cmd_sanitized = redact_secrets(&prepared.cmd);
    let args_sanitized = redact_secret_args(&prepared.args);
    let cwd_sanitized = redact_secrets(&cwd);
    redactions.add(stdout_sanitized.redactions);
    redactions.add(stderr_sanitized.redactions);
    redactions.add(cmd_sanitized.redactions);
    redactions.add(args_sanitized.redactions);
    redactions.add(cwd_sanitized.redactions);

    events.push(event(
        &command_id,
        "exited",
        Some(format!("exit code {:?}", exit_status.code())),
    ));

    let files = read_requested_files(
        &prepared,
        &command_id,
        max_file_bytes,
        max_total_file_bytes,
        &mut events,
        &mut redactions,
    )
    .await?;
    if status == "completed" && files.iter().any(|file| file.truncated) {
        status = "outputLimitExceeded";
    }
    cleanup_temp_dir(prepared.temp_dir, &command_id, &mut events);
    let command_id_sanitized = redact_secrets(&command_id);
    redactions.add(command_id_sanitized.redactions);
    let events = sanitize_events(events, &mut redactions);

    let ended_at_ms = now_ms();
    let output_bytes =
        stdout_sanitized.byte_length + stderr_sanitized.byte_length + files_output_bytes(&files);

    Ok(RunnerOutput {
        command_id: command_id_sanitized.text,
        cmd: cmd_sanitized.text,
        args: args_sanitized.args,
        cwd: cwd_sanitized.text,
        status,
        exit_code: exit_status.code(),
        stdout: stdout_sanitized.text,
        stderr: stderr_sanitized.text,
        stdout_truncated: stdout.truncated || stdout_sanitized_truncated,
        stderr_truncated: stderr.truncated || stderr_sanitized_truncated,
        started_at_ms,
        ended_at_ms,
        duration_ms: ended_at_ms.saturating_sub(started_at_ms),
        output_bytes,
        redactions,
        events,
        files,
    })
}

#[cfg(unix)]
fn spawn_signal_cancellation(token: CancellationToken) {
    tokio::spawn(async move {
        let terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate());
        let interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt());
        let Ok(mut terminate) = terminate else {
            return;
        };
        let Ok(mut interrupt) = interrupt else {
            return;
        };
        tokio::select! {
            _ = terminate.recv() => token.cancel(),
            _ = interrupt.recv() => token.cancel(),
        }
    });
}

#[cfg(not(unix))]
fn spawn_signal_cancellation(_token: CancellationToken) {}

#[cfg(unix)]
fn request_graceful_shutdown(child: &mut AsyncGroupChild) {
    let _ = child.signal(Signal::SIGTERM);
}

#[cfg(not(unix))]
fn request_graceful_shutdown(child: &mut AsyncGroupChild) {
    let _ = child.start_kill();
}

fn force_kill(child: &mut AsyncGroupChild) {
    let _ = child.start_kill();
}

async fn wait_after_graceful_shutdown(
    child: &mut AsyncGroupChild,
) -> Result<ExitStatus, RunnerError> {
    let deadline = Instant::now() + Duration::from_millis(GRACEFUL_SHUTDOWN_MS);
    loop {
        if let Some(exit_status) = child
            .try_wait()
            .map_err(|error| RunnerError::Io(error.to_string()))?
        {
            return Ok(exit_status);
        }
        if Instant::now() >= deadline {
            break;
        }
        sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }

    force_kill(child);
    loop {
        if let Some(exit_status) = child
            .try_wait()
            .map_err(|error| RunnerError::Io(error.to_string()))?
        {
            return Ok(exit_status);
        }
        sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
}

fn failed_to_start_output(
    command_id: String,
    cmd: String,
    args: Vec<String>,
    cwd: String,
    started_at_ms: u64,
    message: String,
    mut events: Vec<RunnerEvent>,
) -> RunnerOutput {
    let sanitized = redact_secrets(&message);
    events.push(event(
        &command_id,
        "failedToStart",
        Some(sanitized.text.clone()),
    ));
    let args_sanitized = redact_secret_args(&args);
    let cmd_sanitized = redact_secrets(&cmd);
    let cwd_sanitized = redact_secrets(&cwd);
    let command_id_sanitized = redact_secrets(&command_id);
    let mut redactions = sanitized.redactions;
    redactions.add(cmd_sanitized.redactions);
    redactions.add(args_sanitized.redactions);
    redactions.add(cwd_sanitized.redactions);
    redactions.add(command_id_sanitized.redactions);
    let events = sanitize_events(events, &mut redactions);
    let ended_at_ms = now_ms();
    RunnerOutput {
        command_id: command_id_sanitized.text,
        cmd: cmd_sanitized.text,
        args: args_sanitized.args,
        cwd: cwd_sanitized.text,
        status: "failedToStart",
        exit_code: None,
        stdout: String::new(),
        stderr: sanitized.text,
        stdout_truncated: false,
        stderr_truncated: false,
        started_at_ms,
        ended_at_ms,
        duration_ms: ended_at_ms.saturating_sub(started_at_ms),
        output_bytes: sanitized.byte_length,
        redactions,
        events,
        files: Vec::new(),
    }
}

fn prepare_command(input: &CommandRunInput) -> Result<PreparedCommand, RunnerError> {
    let temp_dir = match &input.temp_dir_prefix {
        Some(prefix) => Some(
            tempfile::Builder::new()
                .prefix(prefix)
                .tempdir()
                .map_err(|error| RunnerError::Io(error.to_string()))?,
        ),
        None => None,
    };
    let temp_dir_path = temp_dir.as_ref().map(TempDir::path);
    let cmd = replace_temp_dir_placeholder(&input.cmd, temp_dir_path)?;
    let args = input
        .args
        .iter()
        .map(|arg| replace_temp_dir_placeholder(arg, temp_dir_path))
        .collect::<Result<Vec<_>, _>>()?;
    let cwd = replace_temp_dir_placeholder(&input.cwd, temp_dir_path)?;
    let mut env = input.env.clone();
    if let Some(path) = temp_dir_path {
        env.insert(
            "REVIEW_RUNNER_TEMP_DIR".to_owned(),
            path.to_string_lossy().into_owned(),
        );
    }
    let env = env
        .into_iter()
        .map(|(key, value)| Ok((key, replace_temp_dir_placeholder(&value, temp_dir_path)?)))
        .collect::<Result<HashMap<_, _>, RunnerError>>()?;
    let read_files = input
        .read_files
        .iter()
        .map(|file| {
            Ok(PreparedReadFile {
                key: file.key.clone(),
                path: replace_temp_dir_placeholder(&file.path, temp_dir_path)?,
                optional: file.optional.unwrap_or(false),
            })
        })
        .collect::<Result<Vec<_>, RunnerError>>()?;

    Ok(PreparedCommand {
        cmd,
        args,
        cwd,
        env,
        read_files,
        temp_dir,
    })
}

fn replace_temp_dir_placeholder(
    value: &str,
    temp_dir: Option<&Path>,
) -> Result<String, RunnerError> {
    if !value.contains(TEMP_DIR_PLACEHOLDER) {
        return Ok(value.to_owned());
    }
    let temp_dir = temp_dir.ok_or_else(|| {
        RunnerError::InvalidInput(format!(
            "{TEMP_DIR_PLACEHOLDER} placeholder requires tempDirPrefix"
        ))
    })?;
    Ok(value.replace(TEMP_DIR_PLACEHOLDER, &temp_dir.to_string_lossy()))
}

async fn read_limited<R>(
    mut reader: R,
    max_bytes: usize,
    limit_token: CancellationToken,
) -> Result<CapturedStream, RunnerError>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut total_bytes = 0usize;
    let mut truncated = false;
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|error| RunnerError::Io(error.to_string()))?;
        if count == 0 {
            break;
        }
        total_bytes = total_bytes.saturating_add(count);
        if output.len() < max_bytes {
            let remaining = max_bytes - output.len();
            output.extend_from_slice(&buffer[..count.min(remaining)]);
        }
        if total_bytes > max_bytes && !truncated {
            truncated = true;
            limit_token.cancel();
        }
    }

    let byte_length = output.len();
    Ok(CapturedStream {
        text: truncate_utf8_bytes(&String::from_utf8_lossy(&output), max_bytes),
        byte_length,
        truncated,
    })
}

struct SanitizedText {
    text: String,
    byte_length: usize,
    redactions: Redactions,
}

struct SanitizedArgs {
    args: Vec<String>,
    redactions: Redactions,
}

fn redact_secrets(text: &str) -> SanitizedText {
    static BEARER: OnceLock<Regex> = OnceLock::new();
    static SECRET_LIKE: OnceLock<Vec<Regex>> = OnceLock::new();
    static KEY_VALUE_SECRET: OnceLock<Regex> = OnceLock::new();
    static COLON_SECRET: OnceLock<Regex> = OnceLock::new();
    static URI_CREDENTIALS: OnceLock<Regex> = OnceLock::new();
    let bearer = BEARER.get_or_init(|| {
        Regex::new(r"(?i)\bBearer\s+[a-zA-Z0-9._~+/=-]+").expect("valid bearer regex")
    });
    let secret_like = SECRET_LIKE.get_or_init(|| {
        [
            r"\bsk-[a-zA-Z0-9_-]{20,}\b",
            r"\bsk-or-v1-[a-zA-Z0-9_-]{20,}\b",
            r"\bsk-ant-[a-zA-Z0-9_-]{20,}\b",
            r"\bgh[pousr]_[a-zA-Z0-9_]{20,}\b",
            r"\bgithub_pat_[a-zA-Z0-9_]{20,}\b",
            r"\bxox[baprs]-[a-zA-Z0-9-]{10,}\b",
            r"\bAKIA[0-9A-Z]{16}\b",
        ]
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("valid secret-like regex"))
        .collect()
    });
    let key_value_secret = KEY_VALUE_SECRET.get_or_init(|| {
        Regex::new(
            r#"(?i)(["']?[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|DATABASE_URL|AUTH)[A-Z0-9_]*["']?\s*=\s*)(?:"[^"]*"|'[^']*'|[^\r\n,}]+)"#,
        )
        .expect("valid key-value secret regex")
    });
    let colon_secret = COLON_SECRET.get_or_init(|| {
        Regex::new(
            r#"(?i)(["']?[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|DATABASE_URL|AUTH)[A-Z0-9_]*["']?\s*:\s*)(?:"[^"]*"|'[^']*'|[^\r\n,}]+)"#,
        )
        .expect("valid colon secret regex")
    });
    let uri_credentials = URI_CREDENTIALS.get_or_init(|| {
        Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://)([^/\s:@]+):([^/\s@]+)@")
            .expect("valid URI credentials regex")
    });

    let bearer_count = bearer.find_iter(text).count();
    let mut sanitized = bearer.replace_all(text, "Bearer [REDACTED]").into_owned();
    let mut api_key_like_count = 0usize;
    for regex in secret_like {
        api_key_like_count += regex.find_iter(&sanitized).count();
        sanitized = regex
            .replace_all(&sanitized, "[REDACTED_SECRET]")
            .into_owned();
    }
    api_key_like_count += key_value_secret.find_iter(&sanitized).count();
    sanitized = key_value_secret
        .replace_all(&sanitized, "$1[REDACTED_SECRET]")
        .into_owned();
    api_key_like_count += colon_secret.find_iter(&sanitized).count();
    sanitized = colon_secret
        .replace_all(&sanitized, "$1[REDACTED_SECRET]")
        .into_owned();
    api_key_like_count += uri_credentials.find_iter(&sanitized).count();
    sanitized = uri_credentials
        .replace_all(&sanitized, "$1[REDACTED]@")
        .into_owned();
    let byte_length = sanitized.len();

    SanitizedText {
        text: sanitized,
        byte_length,
        redactions: Redactions {
            api_key_like: api_key_like_count,
            bearer: bearer_count,
        },
    }
}

fn redact_and_cap_secrets(text: &str, max_bytes: usize) -> (SanitizedText, bool) {
    let mut sanitized = redact_secrets(text);
    if sanitized.byte_length <= max_bytes {
        return (sanitized, false);
    }
    sanitized.text = truncate_utf8_bytes(&sanitized.text, max_bytes);
    sanitized.byte_length = sanitized.text.len();
    (sanitized, true)
}

fn truncate_utf8_bytes(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_owned();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn redact_secret_args(args: &[String]) -> SanitizedArgs {
    let mut redactions = Redactions::default();
    let args = args
        .iter()
        .map(|arg| {
            let sanitized = redact_secrets(arg);
            redactions.add(sanitized.redactions);
            sanitized.text
        })
        .collect();

    SanitizedArgs { args, redactions }
}

fn sanitize_events(events: Vec<RunnerEvent>, redactions: &mut Redactions) -> Vec<RunnerEvent> {
    events
        .into_iter()
        .map(|event| {
            let RunnerEvent {
                type_,
                command_id,
                timestamp_ms,
                message,
            } = event;
            let command_id = redact_secrets(&command_id);
            redactions.add(command_id.redactions);
            let message = message.map(|message| {
                let sanitized = redact_secrets(&message);
                redactions.add(sanitized.redactions);
                sanitized.text
            });
            RunnerEvent {
                type_,
                command_id: command_id.text,
                timestamp_ms,
                message,
            }
        })
        .collect()
}

async fn read_requested_files(
    prepared: &PreparedCommand,
    command_id: &str,
    max_file_bytes: usize,
    max_total_file_bytes: usize,
    events: &mut Vec<RunnerEvent>,
    redactions: &mut Redactions,
) -> Result<Vec<RunnerFile>, RunnerError> {
    let mut files = Vec::new();
    let mut remaining_total_bytes = max_total_file_bytes;
    for file in &prepared.read_files {
        let limit = max_file_bytes.min(remaining_total_bytes);
        match read_file_limited(&file.path, limit) {
            Ok(content) => {
                let captured_byte_length = content.byte_length;
                let (sanitized, sanitized_truncated) = redact_and_cap_secrets(&content.text, limit);
                let key_sanitized = redact_secrets(&file.key);
                let path_sanitized = redact_secrets(&file.path);
                let mut file_redactions = sanitized.redactions;
                file_redactions.add(key_sanitized.redactions);
                file_redactions.add(path_sanitized.redactions);
                redactions.add(sanitized.redactions);
                redactions.add(key_sanitized.redactions);
                redactions.add(path_sanitized.redactions);
                remaining_total_bytes = remaining_total_bytes.saturating_sub(captured_byte_length);
                events.push(event(
                    command_id,
                    "tempFileRead",
                    Some(key_sanitized.text.clone()),
                ));
                if content.truncated || sanitized_truncated {
                    events.push(event(
                        command_id,
                        "fileLimitExceeded",
                        Some(key_sanitized.text.clone()),
                    ));
                }
                files.push(RunnerFile {
                    key: key_sanitized.text,
                    path: path_sanitized.text,
                    content: sanitized.text,
                    byte_length: captured_byte_length,
                    truncated: content.truncated || sanitized_truncated,
                    redactions: file_redactions,
                });
            }
            Err(error) if file.optional => {
                events.push(event(
                    command_id,
                    "tempFileRead",
                    Some(format!("optional file missing: {}", file.key)),
                ));
                let _ = error;
            }
            Err(error) => return Err(RunnerError::Io(error.to_string())),
        }
    }
    Ok(files)
}

fn read_file_limited(path: &str, max_bytes: usize) -> Result<CapturedStream, RunnerError> {
    if max_bytes == 0 {
        return Ok(CapturedStream {
            text: String::new(),
            byte_length: 0,
            truncated: true,
        });
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|error| RunnerError::Io(error.to_string()))?;
    if !metadata.file_type().is_file() {
        return Ok(CapturedStream {
            text: String::new(),
            byte_length: 0,
            truncated: true,
        });
    }
    let file = fs::File::open(path).map_err(|error| RunnerError::Io(error.to_string()))?;
    let limit = u64::try_from(max_bytes.saturating_add(1)).unwrap_or(u64::MAX);
    let mut reader = file.take(limit);
    let mut output = Vec::new();
    reader
        .read_to_end(&mut output)
        .map_err(|error| RunnerError::Io(error.to_string()))?;
    let truncated = output.len() > max_bytes;
    if truncated {
        output.truncate(max_bytes);
    }

    Ok(CapturedStream {
        text: truncate_utf8_bytes(&String::from_utf8_lossy(&output), max_bytes),
        byte_length: output.len(),
        truncated,
    })
}

fn cleanup_temp_dir(temp_dir: Option<TempDir>, command_id: &str, events: &mut Vec<RunnerEvent>) {
    if let Some(temp_dir) = temp_dir {
        let path = temp_dir.path().to_path_buf();
        match temp_dir.close() {
            Ok(()) => {
                events.push(event(command_id, "tempDirCleaned", None));
            }
            Err(error) => {
                if recover_temp_dir_cleanup(&path).is_ok() {
                    events.push(event(
                        command_id,
                        "tempDirCleaned",
                        Some("cleanup recovered after close failure".to_owned()),
                    ));
                } else {
                    events.push(event(
                        command_id,
                        "tempDirCleanupFailed",
                        Some(error.to_string()),
                    ));
                }
            }
        }
    }
}

fn recover_temp_dir_cleanup(path: &Path) -> Result<(), RunnerError> {
    relax_temp_permissions(path).map_err(|error| RunnerError::Io(error.to_string()))?;
    fs::remove_dir_all(path).map_err(|error| RunnerError::Io(error.to_string()))
}

#[cfg(unix)]
fn relax_temp_permissions(path: &Path) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        for entry in fs::read_dir(path)? {
            relax_temp_permissions(&entry?.path())?;
        }
    } else {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn relax_temp_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn event(command_id: &str, type_: &'static str, message: Option<String>) -> RunnerEvent {
    RunnerEvent {
        type_,
        command_id: command_id.to_owned(),
        timestamp_ms: now_ms(),
        message,
    }
}

fn files_output_bytes(files: &[RunnerFile]) -> usize {
    files
        .iter()
        .map(|file| file.content.len())
        .fold(0usize, usize::saturating_add)
}

fn positive_ms(value: Option<i64>, fallback: u64) -> Result<u64, RunnerError> {
    match value {
        Some(value) if value > 0 => {
            u64::try_from(value).map_err(|error| RunnerError::InvalidInput(error.to_string()))
        }
        Some(_) => Err(RunnerError::InvalidInput(
            "duration must be positive".to_owned(),
        )),
        None => Ok(fallback),
    }
}

fn positive_usize(value: Option<i64>, fallback: usize) -> Result<usize, RunnerError> {
    match value {
        Some(value) if value > 0 => {
            usize::try_from(value).map_err(|error| RunnerError::InvalidInput(error.to_string()))
        }
        Some(_) => Err(RunnerError::InvalidInput(
            "byte limit must be positive".to_owned(),
        )),
        None => Ok(fallback),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    use serde_json::json;

    fn shell() -> &'static str {
        if Path::new("/usr/bin/bash").exists() {
            "/usr/bin/bash"
        } else {
            "/bin/bash"
        }
    }

    #[tokio::test]
    async fn captures_and_redacts_output() {
        let output = run_command_value(json!({
            "commandId": "cmd-redact",
            "cmd": shell(),
            "args": ["-lc", "printf 'token sk-abcdefghijklmnopqrstuvwxyz123456\\nBearer abc.def_123\\nghp_abcdefghijklmnopqrstuvwxyz123456\\nOPENAI_API_KEY=abc123456789\\npostgres://user:pass@example.com/db\\n'"],
            "cwd": std::env::current_dir().unwrap(),
            "readFiles": []
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "completed");
        assert!(!output["stdout"].as_str().unwrap().contains("sk-"));
        assert!(!output["stdout"].as_str().unwrap().contains("ghp_"));
        assert!(!output["stdout"].as_str().unwrap().contains("abc123456789"));
        assert!(!output["stdout"].as_str().unwrap().contains("user:pass"));
        assert!(
            output["stdout"]
                .as_str()
                .unwrap()
                .contains("[REDACTED_SECRET]")
        );
        assert!(!output["args"][1].as_str().unwrap().contains("sk-"));
        assert!(output["redactions"]["apiKeyLike"].as_u64().unwrap() >= 6);
        assert!(output["redactions"]["bearer"].as_u64().unwrap() >= 1);
    }

    #[tokio::test]
    async fn redacts_json_and_yaml_secret_values() {
        let output = run_command_value(json!({
            "commandId": "cmd-redact-json-yaml",
            "cmd": shell(),
            "args": ["-lc", "printf '%s\\n' '{\"CODEX_API_KEY\":\"opaque-json-token\"}' 'token: opaque-yaml-token' 'OPENAI_API_KEY = \"opaque-spaced-token\"' 'PASSWORD = \"correct horse battery staple\"' 'DATABASE_PASSWORD = correct horse battery staple' 'auth: top secret phrase'"],
            "cwd": std::env::current_dir().unwrap(),
            "readFiles": []
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "completed");
        assert!(
            !output["stdout"]
                .as_str()
                .unwrap()
                .contains("opaque-json-token")
        );
        assert!(
            !output["stdout"]
                .as_str()
                .unwrap()
                .contains("opaque-yaml-token")
        );
        assert!(
            !output["stdout"]
                .as_str()
                .unwrap()
                .contains("opaque-spaced-token")
        );
        assert!(
            !output["stdout"]
                .as_str()
                .unwrap()
                .contains("correct horse battery staple")
        );
        assert!(
            !output["stdout"]
                .as_str()
                .unwrap()
                .contains("top secret phrase")
        );
        assert!(
            !output["args"][1]
                .as_str()
                .unwrap()
                .contains("correct horse battery staple")
        );
        assert!(output["redactions"]["apiKeyLike"].as_u64().unwrap() >= 6);
    }

    #[tokio::test]
    async fn caps_invalid_utf8_after_lossy_conversion() {
        let output = run_command_value(json!({
            "commandId": "cmd-invalid-utf8",
            "cmd": shell(),
            "args": ["-c", "printf '\\377\\377\\377\\377\\377\\377\\377\\377\\377\\377'"],
            "cwd": std::env::current_dir().unwrap(),
            "maxStdoutBytes": 4,
            "readFiles": []
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "outputLimitExceeded");
        assert!(output["stdout"].as_str().unwrap().len() <= 4);
        assert!(output["outputBytes"].as_u64().unwrap() <= 4);
    }

    #[tokio::test]
    async fn redacts_command_args_in_audit_output() {
        let output = run_command_value(json!({
            "commandId": "cmd-redact-args",
            "cmd": shell(),
            "args": ["-lc", "printf ok", "--token=sk-abcdefghijklmnopqrstuvwxyz123456"],
            "cwd": std::env::current_dir().unwrap(),
            "readFiles": []
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "completed");
        assert!(!output["args"][2].as_str().unwrap().contains("sk-"));
        assert!(output["redactions"]["apiKeyLike"].as_u64().unwrap() >= 1);
    }

    #[tokio::test]
    async fn redacts_failed_start_events() {
        let output = run_command_value(json!({
            "commandId": "cmd-failed-redact",
            "cmd": "/definitely/missing/sk-abcdefghijklmnopqrstuvwxyz123456",
            "args": [],
            "cwd": std::env::current_dir().unwrap(),
            "readFiles": []
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "failedToStart");
        assert!(!output["cmd"].as_str().unwrap().contains("sk-"));
        assert!(!output["stderr"].as_str().unwrap().contains("sk-"));
        assert!(
            !output["events"][0]["message"]
                .as_str()
                .unwrap()
                .contains("sk-")
        );
    }

    #[tokio::test]
    async fn failed_start_with_tempdir_reports_cleanup_event() {
        let output = run_command_value(json!({
            "commandId": "cmd-failed-start-tempdir",
            "cmd": "{tempDir}/missing-command",
            "args": [],
            "cwd": std::env::current_dir().unwrap(),
            "tempDirPrefix": "review-runner-test-",
            "readFiles": []
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "failedToStart");
        assert!(
            output["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["type"] == "tempDirCleaned")
        );
    }

    #[tokio::test]
    async fn truncates_and_kills_output_limit() {
        let output = run_command_value(json!({
            "commandId": "cmd-limit",
            "cmd": shell(),
            "args": ["-lc", "yes x"],
            "cwd": std::env::current_dir().unwrap(),
            "maxStdoutBytes": 64,
            "timeoutMs": 5000,
            "readFiles": []
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "outputLimitExceeded");
        assert_eq!(output["stdoutTruncated"], true);
        assert!(output["stdout"].as_str().unwrap().len() <= 64);
    }

    #[tokio::test]
    async fn marks_fast_exit_truncated_output_as_limit_exceeded() {
        let output = run_command_value(json!({
            "commandId": "cmd-fast-limit",
            "cmd": shell(),
            "args": ["-lc", "printf abcdefghij"],
            "cwd": std::env::current_dir().unwrap(),
            "maxStdoutBytes": 4,
            "readFiles": []
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "outputLimitExceeded");
        assert_eq!(output["stdout"], "abcd");
        assert_eq!(output["stdoutTruncated"], true);
    }

    #[tokio::test]
    async fn times_out_process_group() {
        let output = run_command_value(json!({
            "commandId": "cmd-timeout",
            "cmd": shell(),
            "args": ["-lc", "sleep 5"],
            "cwd": std::env::current_dir().unwrap(),
            "timeoutMs": 50,
            "readFiles": []
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "timedOut");
        assert_eq!(output["exitCode"], Value::Null);
    }

    #[tokio::test]
    async fn reads_temp_files_and_cleans_tempdir() {
        let output = run_command_value(json!({
            "commandId": "cmd-tempdir",
            "cmd": shell(),
            "args": ["-lc", "printf '{\"ok\":true}' > \"$REVIEW_RUNNER_TEMP_DIR/out.json\""],
            "cwd": std::env::current_dir().unwrap(),
            "tempDirPrefix": "review-runner-test-",
            "readFiles": [{ "key": "out", "path": "{tempDir}/out.json" }]
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "completed");
        assert_eq!(output["files"][0]["content"], "{\"ok\":true}");
        assert_eq!(output["files"][0]["truncated"], false);
        assert!(
            output["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["type"] == "tempDirCleaned")
        );
        let path = output["files"][0]["path"].as_str().unwrap();
        assert!(!PathBuf::from(path).exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cleanup_failure_stays_structured_and_is_reported() {
        let output = run_command_value(json!({
            "commandId": "cmd-tempdir-cleanup-recover",
            "cmd": shell(),
            "args": ["-lc", "mkdir \"$REVIEW_RUNNER_TEMP_DIR/locked\"; printf data > \"$REVIEW_RUNNER_TEMP_DIR/locked/file.txt\"; chmod 000 \"$REVIEW_RUNNER_TEMP_DIR/locked\""],
            "cwd": std::env::current_dir().unwrap(),
            "tempDirPrefix": "review-runner-test-",
            "readFiles": []
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "completed");
        assert!(
            output["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["type"] == "tempDirCleaned")
        );
    }

    #[tokio::test]
    async fn caps_requested_temp_file_capture() {
        let output = run_command_value(json!({
            "commandId": "cmd-file-limit",
            "cmd": shell(),
            "args": ["-lc", "printf 'abcdefghij' > \"$REVIEW_RUNNER_TEMP_DIR/out.txt\""],
            "cwd": std::env::current_dir().unwrap(),
            "tempDirPrefix": "review-runner-test-",
            "maxFileBytes": 4,
            "maxTotalFileBytes": 4,
            "readFiles": [{ "key": "out", "path": "{tempDir}/out.txt" }]
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "outputLimitExceeded");
        assert_eq!(output["files"][0]["content"], "abcd");
        assert_eq!(output["files"][0]["truncated"], true);
        assert!(
            output["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["type"] == "fileLimitExceeded")
        );
    }

    #[tokio::test]
    async fn caps_invalid_utf8_requested_file_after_lossy_conversion() {
        let output = run_command_value(json!({
            "commandId": "cmd-invalid-utf8-file",
            "cmd": shell(),
            "args": ["-c", "printf '\\377\\377\\377\\377\\377\\377\\377\\377\\377\\377' > \"$REVIEW_RUNNER_TEMP_DIR/out.txt\""],
            "cwd": std::env::current_dir().unwrap(),
            "tempDirPrefix": "review-runner-test-",
            "maxFileBytes": 4,
            "maxTotalFileBytes": 4,
            "readFiles": [{ "key": "out", "path": "{tempDir}/out.txt" }]
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "outputLimitExceeded");
        assert!(output["files"][0]["content"].as_str().unwrap().len() <= 4);
        assert!(output["outputBytes"].as_u64().unwrap() <= 4);
        assert_eq!(output["files"][0]["truncated"], true);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_non_regular_requested_file_without_blocking() {
        let output = run_command_value(json!({
            "commandId": "cmd-fifo-file-capture",
            "cmd": shell(),
            "args": ["-lc", "mkfifo \"$REVIEW_RUNNER_TEMP_DIR/out.pipe\""],
            "cwd": std::env::current_dir().unwrap(),
            "tempDirPrefix": "review-runner-test-",
            "maxFileBytes": 4,
            "maxTotalFileBytes": 4,
            "readFiles": [{ "key": "out", "path": "{tempDir}/out.pipe" }]
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "outputLimitExceeded");
        assert_eq!(output["files"][0]["content"], "");
        assert_eq!(output["files"][0]["truncated"], true);
    }

    #[tokio::test]
    async fn caps_aggregate_requested_file_capture() {
        let output = run_command_value(json!({
			"commandId": "cmd-aggregate-file-limit",
			"cmd": shell(),
            "args": ["-lc", "printf abcde > \"$REVIEW_RUNNER_TEMP_DIR/one.txt\"; printf fghij > \"$REVIEW_RUNNER_TEMP_DIR/two.txt\""],
            "cwd": std::env::current_dir().unwrap(),
            "tempDirPrefix": "review-runner-test-",
            "maxFileBytes": 5,
            "maxTotalFileBytes": 6,
            "readFiles": [
                { "key": "one", "path": "{tempDir}/one.txt" },
                { "key": "two", "path": "{tempDir}/two.txt" }
            ]
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "outputLimitExceeded");
        assert_eq!(output["files"][0]["content"], "abcde");
        assert_eq!(output["files"][1]["content"], "f");
        assert_eq!(output["files"][1]["truncated"], true);
    }

    #[tokio::test]
    async fn aggregate_requested_file_cap_counts_captured_bytes_before_redaction() {
        let secret = format!("CODEX_API_KEY={}", "a".repeat(120));
        let script = format!(
            "printf '{}' > \"$REVIEW_RUNNER_TEMP_DIR/one.txt\"; printf second > \"$REVIEW_RUNNER_TEMP_DIR/two.txt\"",
            secret
        );
        let output = run_command_value(json!({
            "commandId": "cmd-aggregate-file-redaction-limit",
            "cmd": shell(),
            "args": ["-lc", script],
            "cwd": std::env::current_dir().unwrap(),
            "tempDirPrefix": "review-runner-test-",
            "maxFileBytes": 200,
            "maxTotalFileBytes": 80,
            "readFiles": [
                { "key": "one", "path": "{tempDir}/one.txt" },
                { "key": "two", "path": "{tempDir}/two.txt" }
            ]
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "outputLimitExceeded");
        assert!(
            output["files"][0]["content"]
                .as_str()
                .unwrap()
                .contains("[REDACTED_SECRET]")
        );
        assert_eq!(output["files"][0]["byteLength"], 80);
        assert_eq!(output["files"][1]["content"], "");
        assert_eq!(output["files"][1]["truncated"], true);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_sends_graceful_term_before_hard_kill() {
        let marker = std::env::temp_dir().join(format!("review-runner-term-{}", now_ms()));
        let script = format!(
            "trap 'touch {}; exit 0' TERM; while true; do sleep 0.1; done",
            marker.to_string_lossy()
        );
        let output = run_command_value(json!({
            "commandId": "cmd-graceful-term",
            "cmd": shell(),
            "args": ["-lc", script],
            "cwd": std::env::current_dir().unwrap(),
            "timeoutMs": 500,
            "readFiles": []
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "timedOut");
        assert!(marker.exists());
        let _ = fs::remove_file(marker);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kills_nested_process_group_on_timeout() {
        let marker = std::env::temp_dir().join(format!("review-runner-marker-{}", now_ms()));
        let script = format!(
            "trap '' TERM; (sleep 3; touch {}) & wait",
            marker.to_string_lossy()
        );
        let output = run_command_value(json!({
            "commandId": "cmd-group-kill",
            "cmd": shell(),
            "args": ["-lc", script],
            "cwd": std::env::current_dir().unwrap(),
            "timeoutMs": 50,
            "readFiles": []
        }))
        .await
        .expect("runner output");

        assert_eq!(output["status"], "timedOut");
        tokio::time::sleep(Duration::from_millis(3200)).await;
        assert!(!marker.exists(), "nested child should have been killed");
    }
}
