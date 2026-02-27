import { Command } from "commander";
import { apiRequest, formatApiError } from "../lib/api-client.js";
import * as log from "../utils/logger.js";

export function registerNotificationCommands(program: Command): void {
  const notif = program
    .command("notifications")
    .description("View and manage user notifications. Notifications are triggered by content verification, generation runs, and other system events.");

  notif
    .command("list")
    .description("List notifications for the current user. Use --unread-only to filter to unread notifications.")
    .option("--limit <n>", "Maximum notifications to return (default: 50, max: 200)")
    .option("--offset <n>", "Number of notifications to skip (for pagination)")
    .option("--unread-only", "Only return unread notifications")
    .action(async (cmdOpts: Record<string, string | boolean>) => {
      const opts = program.opts();
      try {
        const data = await apiRequest({
          path: "/app/v1/notifications",
          params: {
            limit: cmdOpts.limit as string | undefined,
            offset: cmdOpts.offset as string | undefined,
            unread_only: cmdOpts.unreadOnly ? "true" : undefined,
          },
          apiKey: opts.apiKey,
          baseUrl: opts.baseUrl,
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        log.error(formatApiError(err));
        process.exit(1);
      }
    });

  notif
    .command("read <id>")
    .description("Mark a notification as read.")
    .action(async (id: string) => {
      const opts = program.opts();
      try {
        await apiRequest({
          method: "PATCH",
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
