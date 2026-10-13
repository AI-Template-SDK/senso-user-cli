import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { CliError, EXIT } from "../lib/errors.js";
import { parseEnumFlag } from "../lib/enum-arg.js";
import { emitConfirmation } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";

/**
 * `senso request-upgrade` — ask the Senso team for an upgrade, or for help,
 * through `POST /org/credits/upgrade-request`.
 *
 * THE SAME REQUESTS THE ZMP APP SENDS. The `request_type` and the `feature`,
 * `category` and `intent` metadata are copied verbatim from the app
 * (sensov2 `src/app/zmp/constants.ts`), because the partner's Upgrade Requests
 * page labels a request by exactly those strings: the type's last segment
 * becomes its name, `category` decides who handles it, `intent` is the
 * sentence shown. A request from the CLI must read the same as one from the
 * app, or the team sees two kinds of the same thing.
 *
 * Two categories, from the type's prefix:
 *   - `upgrade-optimization.*` asks to move the workspace to the Optimization
 *     tier, or for a feature only that tier has;
 *   - `contact-zeta.*` is an inquiry, not an upgrade: it asks the Zeta team to
 *     follow up, and changes nothing about the plan.
 *
 * ONE OPEN REQUEST PER TYPE. Asking again while a request of the same type is
 * open returns that request, and the team is not notified twice. Both are a
 * success; `alreadyRequested` says which happened.
 */

const REQUESTS = {
  plan: {
    requestType: "upgrade-optimization.plan",
    intent: "Move the workspace to Optimization",
    summary: "Move the workspace to the Optimization tier",
  },
  "fix-answer-gaps": {
    requestType: "upgrade-optimization.fix-answer-gaps",
    feature: "fix-gaps",
    intent: "Fix what AI answers were missing",
    summary: "Optimization: fix what AI answers were missing",
  },
  "track-from-drafts": {
    requestType: "upgrade-optimization.track-from-drafts",
    feature: "drafts",
    intent: "Track a page from a Senso draft",
    summary: "Optimization: track a page from a Senso draft",
  },
  "factual-accuracy": {
    requestType: "upgrade-optimization.factual-accuracy",
    feature: "factual-accuracy",
    intent: "See where AI answers get their facts wrong, and correct them",
    summary: "Optimization: see and correct factual errors in AI answers",
  },
  "activate-audience": {
    requestType: "contact-zeta.activate-audience",
    feature: "activate audience",
    intent: "Reach an audience through Zeta's paid channels",
    summary: "Ask the Zeta team about reaching an audience through paid channels",
  },
  "recommendation-help": {
    requestType: "contact-zeta.recommendation-help",
    feature: "recommendation help",
    intent: "Have the Zeta team help with a Feed recommendation",
    summary: "Ask the Zeta team for help with a recommendation",
  },
} as const satisfies Record<
  string,
  { requestType: string; feature?: string; intent: string; summary: string }
>;

type RequestName = keyof typeof REQUESTS;

const REQUEST_NAMES = Object.keys(REQUESTS) as RequestName[];

/** `metadata.category`, from the type's prefix — the app's `upgradeRequestCategory`. */
function category(requestType: string): "Contact Zeta" | "Upgrade to Optimization" {
  return requestType.startsWith("contact-zeta.") ? "Contact Zeta" : "Upgrade to Optimization";
}

/**
 * What the request is recorded as coming from. The app sends its page's route;
 * a CLI request has no page, so it says "cli". The requester is recorded by the
 * API: the logged-in user, or for an API key the user who created that key —
 * for a key `senso login` minted, the admin who approved the device.
 */
const REQUEST_SOURCE = "cli";

interface RequestUpgradeOptions {
  persona?: string;
  recommendation?: string;
  note?: string;
}

interface UpgradeRequestResponse {
  org_name?: string;
  already_requested?: boolean;
  upgrade_request?: {
    request_id?: string;
    request_type?: string;
    created_at?: string;
    [key: string]: unknown;
  };
}

/**
 * A flag that only means something for one request, refused for the others
 * rather than sent and ignored — an agent that passes `--persona` with `plan`
 * has misunderstood something, and saying so is cheaper than a request the
 * team cannot make sense of.
 */
function onlyFor(
  flag: string,
  value: string | undefined,
  allowed: RequestName,
  actual: RequestName,
): void {
  if (value !== undefined && actual !== allowed) {
    throw new CliError(`${flag} only applies to \`${allowed}\`.`, EXIT.USAGE, {
      code: "usage",
      hint: `Drop ${flag}, or run \`senso request-upgrade ${allowed} ${flag} <value>\`.`,
    });
  }
}

function nonEmpty(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) {
    throw new CliError(`${flag} cannot be empty.`, EXIT.USAGE, { code: "usage" });
  }
  return trimmed;
}

/** "Oct 13, 2026", or the timestamp itself if it does not parse. */
function day(iso: string | undefined): string {
  if (!iso) return "earlier";
  const ms = Date.parse(iso);
  return Number.isNaN(ms)
    ? iso
    : `on ${new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

export function registerRequestUpgradeCommand(program: Command): void {
  program
    .command("request-upgrade [request]")
    .description(
      `Ask the Senso team to upgrade your organization, or to follow up on something, and notify them. [request] is one of: ${REQUEST_NAMES.map((n) => `${n} (${REQUESTS[n].summary})`).join("; ")}. Defaults to plan. One open request per kind: asking again returns the open one and does not notify the team twice.`,
    )
    .option("--persona <name>", "With activate-audience: the audience or persona to reach")
    .option(
      "--recommendation <text>",
      "With recommendation-help: the recommendation you want help with",
    )
    .option("--note <text>", "Anything the team should know when they follow up")
    .action(
      runAction(
        program,
        async (ctx, requested: string | undefined, opts: RequestUpgradeOptions) => {
          // Every check before the request: a typo exits 2 and notifies nobody.
          const name = parseEnumFlag("[request]", requested ?? "plan", REQUEST_NAMES) ?? "plan";
          onlyFor("--persona", opts.persona, "activate-audience", name);
          onlyFor("--recommendation", opts.recommendation, "recommendation-help", name);
          const persona = nonEmpty("--persona", opts.persona);
          const recommendation = nonEmpty("--recommendation", opts.recommendation);
          const note = nonEmpty("--note", opts.note);

          const preset: { requestType: string; feature?: string; intent: string } = REQUESTS[name];
          const metadata: Record<string, string> = {
            ...(preset.feature ? { feature: preset.feature } : {}),
            category: category(preset.requestType),
            intent: preset.intent,
            ...(persona ? { persona } : {}),
            ...(recommendation ? { recommendation } : {}),
            ...(note ? { note } : {}),
          };

          const data = await apiRequest<UpgradeRequestResponse>({
            method: "POST",
            path: "/org/credits/upgrade-request",
            body: {
              request_type: preset.requestType,
              request_source: REQUEST_SOURCE,
              metadata,
            },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });

          const already = data.already_requested === true;
          const record = data.upgrade_request ?? {};
          const message = already
            ? `You already asked for this ${day(record.created_at)}. The team has it and will follow up.`
            : "Request sent. The team will follow up.";

          emitConfirmation(ctx, message, {
            requestId: record.request_id,
            request: name,
            requestType: record.request_type ?? preset.requestType,
            category: metadata.category,
            alreadyRequested: already,
            createdAt: record.created_at,
            orgName: data.org_name,
          });
        },
      ),
    );
}
