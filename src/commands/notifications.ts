import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerNotificationCommands(program: Command): void {
  const notif = program
    .command("notifications")
    .description("Manage notifications");

  notif
    .command("list")
    .description("List notifications")
    .action(async () => {
      const opts = program.opts();
      try {
        const data = await apiRequest({ path: "/app/v1/notifications", apiKey: opts.apiKey, baseUrl: opts.baseUrl });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  notif
    .command("read <id>")
    .description("Mark notification as read")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        await apiRequest({
          method: "POST",
          path: `/app/v1/notifications/${id}/read`,
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        log.success(`Notification ${id} marked as read.`);
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });
}
