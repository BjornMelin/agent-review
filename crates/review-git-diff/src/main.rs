use std::io::{self, Read};
use std::path::PathBuf;

use clap::{Parser, Subcommand};
use review_git_diff::parse_unified_diff;

#[derive(Debug, Parser)]
#[command(name = "review-git-diff")]
#[command(about = "Review-agent git diff helper")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Parse a unified git diff from stdin and emit normalized chunk JSON.
    Parse {
        /// Repository root used to resolve absolute chunk paths.
        #[arg(long)]
        cwd: PathBuf,
    },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command {
        Command::Parse { cwd } => {
            let mut patch = String::new();
            io::stdin().read_to_string(&mut patch)?;
            let chunks = parse_unified_diff(&cwd, &patch);
            serde_json::to_writer_pretty(io::stdout(), &chunks)?;
            println!();
        }
    }
    Ok(())
}
