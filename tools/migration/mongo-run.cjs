/* global connect, EJSON, quit */
// Load helpers as a Node module so mongosh does not rewrite pure array callbacks.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- This is the mongosh runtime adapter.
const operations = require(process.env.BOTFLEET_MIGRATION_HELPER);
async function execute() {
  try {
    await operations.main({ connect, EJSON });
  } catch {
    quit(1);
  }
}
execute();
