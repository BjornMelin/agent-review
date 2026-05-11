#![forbid(unsafe_code)]

use std::io::{self, Read};

use clap::{Parser, Subcommand};
use review_runner::run_command_value;
use serde_json::Value;

#[derive(Debug, Parser)]
#[command(
    name = "review-runner",
    about = "Run bounded commands for Review Agent"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run one command request from stdin and print one JSON result to stdout.
    Run,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Run => run_from_stdin().await,
    };

    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run_from_stdin() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let value: Value = serde_json::from_str(&input)?;
    let output = run_command_value(value).await?;
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}
