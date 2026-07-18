# CLI Distribution

This is the release contract for the installable `review-agent` CLI. Hosted
Review Room and service deployment are separate release surfaces.

## Version Authority

`apps/review-cli/package.json` is the only CLI version authority. The runtime
reads it for `review-agent --version`; the release packager derives archive
names from it; and a tag build fails unless `GITHUB_REF_NAME` equals
`v<version>`.

## Runtime and Native Matrix

Every archive requires Node.js 24 or newer and git. Its Rust diff-index and
bounded-command helpers are built with Cargo's `release` profile on the target
host.

| Archive target | GitHub runner | Host contract |
| --- | --- | --- |
| `linux-x64-gnu` | `ubuntu-24.04` | x64 glibc 2.39+, including Ubuntu 24.04 x64 WSL |
| `linux-arm64-gnu` | `ubuntu-24.04-arm` | arm64 glibc 2.39+, including Ubuntu 24.04 arm64 WSL |
| `macos-x64` | `macos-15-intel` | Intel macOS |
| `macos-arm64` | `macos-15` | Apple silicon macOS |
| `windows-x64` | `windows-2025` | x64 Windows |

Windows arm64, musl-based Linux distributions, and glibc releases older than
2.39 are unsupported in v0.1. They require native build-and-smoke evidence
before being added. Linux packaging inspects each helper's ELF version table and
fails if its required glibc version exceeds the documented 2.39 floor.

## Archive Contract

An archive is named `review-agent-v<version>-<target>.tar.gz` and extracts to a
same-named directory. The root contains only:

- `bin/review-agent` and `bin/review-agent.cmd` launchers;
- the CLI's production JavaScript and declarations under `dist/`;
- the isolated production dependency graph under `node_modules/`;
- `LICENSE`, `README.md`, `package.json`, and `RELEASE_MANIFEST.json`.

Every internal `@review-agent/*` package uses an exact `files` allowlist.
Internal workspace sources, tests, source maps, Turbo logs, TypeScript caches,
and Cargo debug binaries are excluded. Third-party production dependencies keep
the files in their upstream published packages. Root and internal package
manifests retain only runtime/package-resolution metadata, pin internal package
versions exactly, and remain `private`; pnpm workspace metadata and generated
`node_modules/.bin` shims are removed.

`RELEASE_MANIFEST.json` lists every other regular file and symlink by path,
size, type, and SHA-256. The verifier rejects extra or missing entries, leaked
workspace/file dependency specs, and builder paths in text artifacts. Packaged
Rust helpers byte-match `target/release`, use deterministic build-path remaps,
and are rejected unless their native symbol/debug tables are stripped.

Each separately published `<archive>.manifest.json` has its own adjacent
`.sha256` file. The release job verifies every per-asset checksum before
combining them into `SHA256SUMS`, so the downloadable manifest is covered as
well as the archive.

Archive creation uses an explicit sorted path list, fixed source-commit mtime,
portable ownership metadata, `noDirRecurse`, and portable gzip headers. The
packager creates the archive twice and requires identical SHA-256 hashes. This
proves determinism for the same staging tree and toolchain invocation. The Rust
release is pinned in `rust-toolchain.toml`; updating that pin is an explicit
release-toolchain change.

## Install

Linux x64 example:

```bash
version=v0.1.1
target=linux-x64-gnu
artifact="review-agent-${version}-${target}.tar.gz"
manifest="${artifact%.tar.gz}.manifest.json"

gh release download "$version" \
  --repo BjornMelin/agent-review \
  --pattern "$artifact" \
  --pattern "$artifact.sha256" \
  --pattern "$manifest" \
  --pattern "$manifest.sha256"
sha256sum -c "$artifact.sha256" "$manifest.sha256"
tar -xzf "$artifact"
export PATH="$PWD/review-agent-${version}-${target}/bin:$PATH"
review-agent --version
review-agent models --json
```

On macOS, use the matching `macos-*` target and verify with
`shasum -a 256 -c "$artifact.sha256" "$manifest.sha256"`. On Windows
PowerShell:

```powershell
$Version = "v0.1.1"
$Target = "windows-x64"
$Artifact = "review-agent-$Version-$Target.tar.gz"
$Manifest = $Artifact -replace '\.tar\.gz$', '.manifest.json'
gh release download $Version --repo BjornMelin/agent-review --pattern $Artifact --pattern "$Artifact.sha256" --pattern $Manifest --pattern "$Manifest.sha256"
foreach ($File in @($Artifact, $Manifest)) {
  $Expected = (Get-Content "${File}.sha256").Split(" ")[0]
  $Actual = (Get-FileHash $File -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw "SHA-256 mismatch for $File" }
}
tar -xzf $Artifact
& ".\review-agent-$Version-$Target\bin\review-agent.cmd" --version
```

## Machine Output and Exit Codes

Use `--format json --output review.json` for review artifacts and `--json` for
`models` or `doctor`. Process codes are stable automation contracts:

| Code | Contract |
| ---: | --- |
| `0` | No findings cross the configured threshold. |
| `1` | Findings exist at or above the configured threshold. |
| `2` | Usage, target, schema, provider selection, or format failure. |
| `3` | Authentication, token, or API-key failure. |
| `4` | Provider, command, sandbox, service, or other runtime failure. |

The [GitHub Actions example](../../examples/github-actions/review-agent.yml)
captures the code, classifies `0`, `1`, and `2`–`4`, uploads the JSON report
under `always()`, and only then re-emits the original code. The job is restricted
to same-repository, non-Dependabot pull requests because ordinary provider
secrets are unavailable to fork and Dependabot workflows. Release verification also runs
deterministic mock-provider fixtures proving both `0` and `1` from an extracted
archive in a clean external git repository.

## Release Procedure

1. Update `apps/review-cli/package.json`, every copy-ready install pin, and
   `docs/release/notes/v<version>.md` in one PR. The tag workflow requires that
   versioned note and replaces its `{{SOURCE_SHA}}` placeholder with the tagged
   commit, appends GitHub's generated changelog, and creates one canonical
   release body. A resumed draft must already have the exact canonical title
   and body before it can publish.
2. Run `pnpm install --frozen-lockfile`, `pnpm ci:contracts`, `pnpm run check`,
   `pnpm build`, `bash scripts/repro-check.sh`, and `pnpm ci:cli-release`.
3. Merge only after the required `check` aggregator is green.
4. Create and push an annotated `v<package version>` tag.
5. The `Release CLI` workflow must first pass its five-target matrix on the PR.
   Pushing the tag repeats that matrix, combines checksums into `SHA256SUMS`,
   resumes or creates a draft, verifies uploaded assets by readback, and only
   then publishes the GitHub release.
6. Download the published assets and verify `SHA256SUMS` as release readback.
