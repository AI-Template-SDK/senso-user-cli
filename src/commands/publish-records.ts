import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";

export function registerPublishRecordsCommands(program: Command): void {
  const pr = program
    .command("publish-records")
    .description(
      "Inspect and retry publish records. A publish_record is the unit that tracks one content item's publication to one destination — published/live, pending, failed, unpublished, etc. When a publish fails for a single destination, retry it here without redoing the whole publish.",
    );

  pr.command("retry <publishRecordId>")
    .description(
      "Retry a failed publish record. Re-runs the publish for that specific content+destination pair and flips the record's state based on the new attempt. Only works on records currently in the 'failed' state.",
    )
    .action(
      runAction(program, async (ctx, publishRecordId: string) => {
        await apiRequest({
          method: "POST",
          path: `/org/publish-records/${publishRecordId}/retry`,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
        });
        // The retry endpoint's response was never shown; keep it a confirmation.
        emitConfirmation(ctx, `Publish record ${publishRecordId} retry completed.`);
      }),
    );
}
