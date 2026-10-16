import { writeFile } from 'node:fs/promises';
import { runArchivePipelineProbe } from '../../test/helpers/archive-pipeline-probe';
import { summarize } from './metrics';

async function main(output: string): Promise<void> {
  const variants = [];
  let expected: string | undefined;
  for (const quotaIntervalMs of [0, 5]) {
    for (const concurrency of [2, 4, 8]) {
      for (const prefetch of [false, true]) {
        const samples = [];
        for (let run = 0; run < 3; run += 1) {
          const sample = await runArchivePipelineProbe({
            concurrency,
            prefetch,
            channels: 8,
            pages: 10,
            requestLatencyMs: 5,
            writeLatencyMs: 5,
            quotaIntervalMs,
          });
          expected ??= sample.equivalenceDigest;
          if (
            sample.equivalenceDigest !== expected ||
            sample.issues.length !== 0 ||
            sample.pipeline.reservedBytes !== 0 ||
            sample.pipeline.waiting !== 0
          )
            throw new Error('Pipeline equivalence or drain failed');
          samples.push(sample);
        }
        variants.push({
          quotaIntervalMs,
          concurrency,
          prefetch,
          samples,
          elapsedMs: summarize(samples.map((sample) => sample.elapsedMs)),
        });
      }
    }
  }
  await writeFile(
    output,
    JSON.stringify(
      {
        version: 1,
        variants,
        scope:
          'Real history executor and scheduler against synthetic single shared REST transport and page writer; fixed pages, request/write delays, optional 200 requests/s global ceiling. No Discord or real database. Prefetch false is the sequential-page comparison.',
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
}
if (require.main === module) {
  const output = process.argv[2];
  if (output === undefined) throw new Error('Provide a new output report path');
  void main(output).catch(() => {
    process.stderr.write('Pipeline benchmark failed\n');
    process.exitCode = 1;
  });
}
