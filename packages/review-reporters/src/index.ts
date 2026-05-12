import {
  type ReviewFinding,
  type ReviewResult,
  redactReviewResult,
} from '@review-agent/review-types';

export type SarifLevel = 'error' | 'warning' | 'note';

export type SarifReport = {
  version: '2.1.0';
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json';
  runs: Array<{
    tool: {
      driver: {
        name: string;
        informationUri: string;
        rules: Array<{
          id: string;
          name: string;
          shortDescription: { text: string };
          fullDescription: { text: string };
          defaultConfiguration: { level: SarifLevel };
        }>;
      };
    };
    automationDetails?: { id: string };
    results: Array<{
      ruleId: string;
      level: SarifLevel;
      message: { text: string };
      locations: Array<{
        physicalLocation: {
          artifactLocation: { uri: string };
          region: { startLine: number; endLine: number };
        };
      }>;
      partialFingerprints: { primaryLocationLineHash: string };
      properties: {
        priority: number | null;
        confidenceScore: number;
      };
    }>;
  }>;
};

/**
 * Defines optional overrides used when rendering SARIF output.
 */
export type SarifRenderOptions = {
  /** Maps a finding to the repository-relative path emitted in SARIF. */
  pathForFinding?: (finding: ReviewFinding) => string;
  /** Distinguishes one logical SARIF analysis category for GitHub code scanning. */
  automationId?: string;
};

function normalizePriority(priority: ReviewFinding['priority']): number {
  return priority ?? 3;
}

function priorityToSarifLevel(priority: number): SarifLevel {
  if (priority <= 1) {
    return 'error';
  }
  if (priority === 2) {
    return 'warning';
  }
  return 'note';
}

function findRuleId(finding: ReviewFinding): string {
  const safeTitle = finding.title
    .toLowerCase()
    .replace(/\[p\d\]\s*/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safeTitle || finding.fingerprint.slice(0, 12);
}

export function sortFindingsDeterministically(
  findings: ReviewFinding[]
): ReviewFinding[] {
  return [...findings].sort((left, right) => {
    const priorityCompare =
      normalizePriority(left.priority) - normalizePriority(right.priority);
    if (priorityCompare !== 0) {
      return priorityCompare;
    }

    const pathCompare = left.codeLocation.absoluteFilePath.localeCompare(
      right.codeLocation.absoluteFilePath
    );
    if (pathCompare !== 0) {
      return pathCompare;
    }

    const lineCompare =
      left.codeLocation.lineRange.start - right.codeLocation.lineRange.start;
    if (lineCompare !== 0) {
      return lineCompare;
    }

    const titleCompare = left.title.localeCompare(right.title);
    if (titleCompare !== 0) {
      return titleCompare;
    }

    return left.fingerprint.localeCompare(right.fingerprint);
  });
}

/**
 * Converts a normalized review result into a SARIF 2.1.0 report.
 *
 * @param result - Normalized review result to render.
 * @param options - Optional SARIF rendering overrides.
 * @returns SARIF report object ready for JSON serialization.
 */
export function toSarif(
  result: ReviewResult,
  options: SarifRenderOptions = {}
): SarifReport {
  const safeResult = redactReviewResult(result).result;
  const findings = sortFindingsDeterministically(safeResult.findings);
  const rulesById = new Map<
    string,
    {
      id: string;
      name: string;
      shortDescription: { text: string };
      fullDescription: { text: string };
      defaultConfiguration: { level: SarifLevel };
    }
  >();

  for (const finding of findings) {
    const priority = normalizePriority(finding.priority);
    const id = findRuleId(finding);
    if (!rulesById.has(id)) {
      rulesById.set(id, {
        id,
        name: finding.title,
        shortDescription: { text: finding.title },
        fullDescription: { text: finding.body },
        defaultConfiguration: { level: priorityToSarifLevel(priority) },
      });
    }
  }
  const rules = [...rulesById.values()];

  const results = findings.map((finding) => {
    const priority = normalizePriority(finding.priority);
    return {
      ruleId: findRuleId(finding),
      level: priorityToSarifLevel(priority),
      message: { text: `${finding.title}\n\n${finding.body}`.trim() },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri:
                options.pathForFinding?.(finding) ??
                finding.codeLocation.absoluteFilePath,
            },
            region: {
              startLine: finding.codeLocation.lineRange.start,
              endLine: finding.codeLocation.lineRange.end,
            },
          },
        },
      ],
      partialFingerprints: {
        primaryLocationLineHash: finding.fingerprint,
      },
      properties: {
        priority: finding.priority ?? null,
        confidenceScore: finding.confidenceScore,
      },
    };
  });

  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'review-agent',
            informationUri: 'https://github.com/openai/codex',
            rules,
          },
        },
        ...(options.automationId
          ? { automationDetails: { id: options.automationId } }
          : {}),
        results,
      },
    ],
  };
}

export function renderMarkdown(result: ReviewResult): string {
  const safeResult = redactReviewResult(result).result;
  const findings = sortFindingsDeterministically(safeResult.findings);
  const lines: string[] = [];

  lines.push('# Review Report');
  lines.push('');
  lines.push(`- Overall correctness: **${safeResult.overallCorrectness}**`);
  lines.push(
    `- Overall confidence: **${safeResult.overallConfidenceScore.toFixed(2)}**`
  );
  lines.push(`- Provider: \`${safeResult.metadata.provider}\``);
  lines.push(`- Model: \`${safeResult.metadata.modelResolved}\``);
  if (safeResult.metadata.sandboxId) {
    lines.push(`- Sandbox: \`${safeResult.metadata.sandboxId}\``);
  }
  lines.push('');
  lines.push(
    safeResult.overallExplanation ||
      'No high-confidence correctness summary provided.'
  );
  lines.push('');

  if (findings.length === 0) {
    lines.push('## Findings');
    lines.push('');
    lines.push('No actionable findings reported.');
    return lines.join('\n');
  }

  lines.push('## Findings');
  for (const finding of findings) {
    const priority = finding.priority ?? 3;
    const title = finding.title.replace(/^\[p\d\]\s*/i, '');
    lines.push('');
    lines.push(`### [P${priority}] ${title}`);
    lines.push(`- File: \`${finding.codeLocation.absoluteFilePath}\``);
    lines.push(
      `- Lines: \`${finding.codeLocation.lineRange.start}-${finding.codeLocation.lineRange.end}\``
    );
    lines.push(`- Confidence: \`${finding.confidenceScore.toFixed(2)}\``);
    lines.push('');
    lines.push(finding.body);
  }

  return lines.join('\n');
}

export function renderJson(result: ReviewResult): string {
  const safeResult = redactReviewResult(result).result;
  return JSON.stringify(
    {
      ...safeResult,
      findings: sortFindingsDeterministically(safeResult.findings),
    },
    null,
    2
  );
}

/**
 * Renders a normalized review result as pretty-printed SARIF JSON.
 *
 * @param result - Normalized review result to render.
 * @param options - Optional SARIF rendering overrides.
 * @returns Pretty-printed SARIF JSON string.
 */
export function renderSarifJson(
  result: ReviewResult,
  options: SarifRenderOptions = {}
): string {
  return JSON.stringify(toSarif(result, options), null, 2);
}
