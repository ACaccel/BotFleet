import { waitForMongo } from './deployment/mongo-probe';

const [envFile, timeout] = process.argv.slice(2);
const seconds = Number(timeout);
if (!envFile || !Number.isInteger(seconds) || seconds < 1 || seconds > 600) {
  console.error('Usage: mongo-ready.ts <env-file> <timeout-seconds>');
  process.exitCode = 1;
} else {
  void waitForMongo(envFile, seconds).catch(() => {
    console.error(
      'MongoDB readiness check failed; inspect the database service and configured credentials.',
    );
    process.exitCode = 1;
  });
}
