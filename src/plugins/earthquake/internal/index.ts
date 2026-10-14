/** Internal barrel for the earthquake plugin. */
export {
  broadcastEarthquakeAlert,
  broadcastEarthquakeReport,
  sendEarthquakeAlert,
} from './broadcast';
export { fetchSignificantReports } from './cwa-client';
export type { ParsedReports } from './cwa-report';
export { createReportPoller, startReportPolling } from './report-poller';
