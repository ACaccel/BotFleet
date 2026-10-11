/**
 * Report emission shared by every command.
 *
 * Serializes the JSON report to the configured `output_path` (or stdout
 * when unset), then writes the human-readable summary line to stdout so
 * the PASS / FAIL / RECOMMENDATION verdict is always visible even when
 * the report itself is redirected to a file. A report file is written
 * with mode 0600 because reports can name private channels.
 */
import { chmodSync, writeFileSync } from 'node:fs';

import type { Logger } from '../../../src/core/logger';

const REPORT_MODE = 0o600;

export const emitReport = (
  report: unknown,
  summaryLine: string,
  outputPath: string | null,
  logger: Logger,
): void => {
  const serialised = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath !== null) {
    writeFileSync(outputPath, serialised, { encoding: 'utf8', mode: REPORT_MODE });
    // `mode` applies only when the file is created; tighten a pre-existing file too.
    chmodSync(outputPath, REPORT_MODE);
    logger.info({ outputPath }, 'db: report written');
  } else {
    process.stdout.write(serialised);
  }
  process.stdout.write(`${summaryLine}\n`);
};
