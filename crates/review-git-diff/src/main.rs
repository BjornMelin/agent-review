use std::io::{self, Read};

use clap::{Parser, Subcommand};
use review_git_diff::{DiffIndexInput, build_diff_index_from_input};

#[derive(Debug, Parser)]
#[command(name = "review-git-diff")]
#[command(about = "Review-agent git diff helper")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Parse, filter, and index unified git diff JSON from stdin.
    Index,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command {
        Command::Index => {
            let mut input = String::new();
            io::stdin().read_to_string(&mut input)?;
            let request: DiffIndexInput = serde_json::from_str(&input)?;
            let output = build_diff_index_from_input(request)?;
            serde_json::to_writer_pretty(io::stdout(), &output)?;
            println!();
        }
    }
    Ok(())
}
