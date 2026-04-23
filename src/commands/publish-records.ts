import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerPublishRecordsCommands(program: Command): void {
  const pr = program
    .command("publish-records")
    .description("Inspect and retry publish records. A publish_record is the unit that tracks one content item's publication to one destination — published/live, pending, failed, unpublished, etc. When a publish fails for a single destination, retry it here without redoing the whole publish.");

  pr
    .command("retry <publishRecordId>")
    .description("Retry a failed publish record. Re-runs the publish for that specific content+destination pair and flips the record's state based on the new attempt. Only works on records currently in the 'failed' state.")
    .action(async (publishRecordId: string) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          method: "POST",
          path: `/org/publish-records/${publishRecordId}/retry`,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Publish record ${publishRecordId} retry triggered.`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
