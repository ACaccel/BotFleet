/**
 * Fetches the newest CWA significant earthquake reports.
 *
 * Uses the shared bounded HTTP client, so the request carries its
 * timeout, response-size and redirect limits. The key travels as the
 * `Authorization` query parameter because that is what the open-data API
 * accepts; axios keeps it in `config.params`, which the log scrubber
 * drops, and the URL scrubber redacts it should it ever appear in a URL
 * string.
 */
import { boundedHttp } from '../../../infra/http';
import { parseReportPayload, type ParsedReports } from './cwa-report';

const CWA_REPORT_URL = 'https://opendata.cwa.gov.tw/api/v1/rest/datastore/E-A0015-001';

/**
 * Reports requested per poll, newest first. A minute between polls
 * rarely sees more than one significant report, so this leaves headroom
 * for a burst of aftershocks while keeping each response small (every
 * report carries its full station list).
 */
const REPORT_PAGE_SIZE = 5;

/** Fetch and parse the newest reports. Throws on transport, HTTP or envelope failure. */
export const fetchSignificantReports = async (apiKey: string): Promise<ParsedReports> => {
  const response = await boundedHttp.get<unknown>(CWA_REPORT_URL, {
    params: { Authorization: apiKey, limit: REPORT_PAGE_SIZE, format: 'JSON' },
  });
  return parseReportPayload(response.data);
};
