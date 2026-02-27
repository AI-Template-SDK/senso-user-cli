import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerIngestCommands(program: Command): void {
  const ingest = program
    .command("ingest")
    .description("Content ingestion (upload, reprocess)");

  ingest
    .command("upload")
    .description("Request presigned S3 upload URLs")
    .requiredOption("--files <filenames...>", "File names to get upload URLs for")
    .action(async (cmdOpts: { files: string[] }) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          method: "POST",
          path: "/org/ingestion/upload",
          body: { files: cmdOpts.files },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  ingest
    .command("reprocess <contentId>")
    .description("Request re-ingestion of existing content")
    .action(async (contentId: string) => {
      const opts = program.opts();
      try {
        await apiRequest({
          method: "POST",
          path: `/org/ingestion/${contentId}/reprocess`,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Reprocess triggered for content ${contentId}.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
