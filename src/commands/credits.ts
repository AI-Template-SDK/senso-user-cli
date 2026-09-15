/**
 * `senso credits`: what the organization has left to spend, and why a 402 happened.
 *
 * This is the command four of the published agent skills reach for the moment
 * something returns 402, so two things matter more here than anywhere else.
 *
 * The bare group runs `balance` — see the `isDefault` note below — because the
 * skills spell it `senso credits --output json`, and a group with no default
 * action printed help and exited 2.
 *
 * And the payload's two billing modes share one shape, in which `null` is the
 * HEALTHY state: an uncapped partner-billed organization reports
 * `credits_available: null`, which the generic plain renderer prints as a blank.
 * An agent reads a blank as zero and concludes it is out of credits. Hence the
 * handwritten plain rendering, which says "unlimited" in words.
 */

import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { describeCommand, idExits } from "../lib/help.js";
import { emit, type NextStep } from "../lib/output.js";
import { runAction } from "../lib/run-action.js";

/**
 * The organization behind the API key, for the 404 this endpoint can return.
 *
 * No id: the caller never passes one — the organization is whichever one the
 * key belongs to — so the failure names the resource and the command that shows
 * which organization that is.
 */
const ORGANIZATION = {
  type: "Organization",
  idField: "org_id",
  list: "senso whoami",
} as const;

/** The balance payload, as much of it as the rendering below needs. */
interface CreditBalance {
  org_id?: string;
  dedicated_balance?: boolean;
  credit_limit_set?: boolean;
  credit_limit?: number | null;
  total_usage?: number;
  credits_available?: number | null;
}

/**
 * One field as text, with the nulls spelled out.
 *
 * `null` means two different things on this payload and neither of them is
 * zero: no spend limit is configured, and therefore no ceiling to run out of.
 */
function balanceValue(key: string, value: unknown): string {
  if (value === null || value === undefined) {
    if (key === "credits_available") return "unlimited (no spend limit on this organization)";
    if (key === "credit_limit") return "none (uncapped)";
    return "";
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Nothing on this payload is nested today, but a field the API adds later
  // should read as JSON rather than "[object Object]".
  return JSON.stringify(value) ?? "";
}

/** The balance as aligned `key  value` lines, in the order the API sends them. */
function balanceLines(data: CreditBalance): string[] {
  const entries = Object.entries(data);
  const width = Math.max(0, ...entries.map(([key]) => key.length));
  return entries.map(([key, value]) => `  ${key.padEnd(width)}  ${balanceValue(key, value)}`);
}

/** What to do next, given how much is left. */
function balanceSteps(available: number | null | undefined): NextStep[] {
  if (available === null || available === undefined) {
    return [
      {
        why: "Nothing is capped — spend against the balance",
        command: 'senso search --query "<terms>"',
      },
    ];
  }
  if (available <= 0) {
    return [
      {
        why: "The balance is exhausted; check the plan and who is billed for it",
        command: "senso org get",
      },
    ];
  }
  return [
    { why: "Spend credits on a generation run", command: "senso generate run --output json" },
  ];
}

export function registerCreditsCommands(program: Command): void {
  const credits = program
    .command("credits")
    .description(
      "The credit balance of the organization this API key belongs to. Credits are spent by AI content generation (`senso generate`) and by search (`senso search`); a 402 from any command in this CLI means this balance, or the organization's spend limit, is exhausted. `senso credits` on its own is the same as `senso credits balance`.",
    );

  describeCommand(credits, {
    notes: [
      "Read-only. Credits are bought and spend limits are set outside this CLI; nothing here changes a balance.",
      "A 402 from `senso generate`, `senso search` or an ingestion command is this balance reaching zero — run `senso credits balance` to confirm before retrying anything.",
    ],
    examples: [
      { command: "senso credits" },
      { command: "senso credits balance --output json | jq .data.credits_available" },
    ],
    seeAlso: ["senso generate run", "senso search", "senso org get"],
  });

  describeCommand(
    credits
      // isDefault: `senso credits` runs this. The group had no default action, so
      // it printed help and exited 2 — and three of the published agent skills
      // instruct `senso credits --output json` verbatim, so the one command they
      // all start with failed for every agent that followed them.
      .command("balance", { isDefault: true })
      .description(
        "Get the organization's credit position: what has been spent, what is left, and whether a spend limit caps it.",
      )
      .action(
        runAction(program, async (ctx) => {
          const data = await apiRequest<CreditBalance>({
            path: "/org/credits/balance",
            resource: ORGANIZATION,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
          });
          const available = data.credits_available;
          emit(ctx, data, {
            // A single balance object, not a list — but the generic key/value
            // renderer prints a null as a blank, and on this payload a blank
            // reads as "zero credits" when it means "no limit".
            plain: balanceLines(data),
            warnings:
              typeof available === "number" && available <= 0
                ? [
                    "No credits available: generation, search and ingestion will fail with 402 until the balance or the spend limit is raised.",
                  ]
                : [],
            next: balanceSteps(available),
          });
        }),
      ),
    {
      returns: [
        "org_id — the organization this key belongs to.",
        "dedicated_balance — true | false, and it decides how to read the two fields below:",
        "  true   the organization holds its own credits. credits_available IS the balance; credit_limit is null.",
        "  false  free tier, billed to the partner. credit_limit is the organization's spend limit and credits_available is credit_limit - total_usage.",
        "credit_limit_set — true when a spend limit is configured. false means uncapped, not zero.",
        "credit_limit — the spend limit, or null when none is set (uncapped).",
        "total_usage — credits spent to date. Only ever grows.",
        "credits_available — what is left. 0 is what produces a 402 elsewhere in the CLI; null means UNLIMITED, not empty — an uncapped partner-billed organization reports null here and is healthy.",
      ],
      exitCodes: {
        ...idExits,
        4: "no organization for this API key — the key was deleted, or it belongs to a removed organization",
      },
      notes: [
        "Credits are spent by AI content generation and by search. Reads such as `senso kb my-files` cost nothing.",
        "A 402 from any other command means this balance reached 0; nothing in this CLI tops it up.",
        "The numbers are not a reservation: a generation run started elsewhere may spend between this call and the next.",
      ],
      examples: [
        { command: "senso credits balance" },
        {
          comment: "What a 402 costs an agent: check before retrying",
          command: "senso credits balance --output json | jq .data.credits_available",
        },
        {
          comment: "Exit non-zero when the balance is empty",
          command:
            'test "$(senso credits balance --output json | jq -r \'.data.credits_available // "null"\')" != 0',
        },
      ],
      seeAlso: ["senso generate run", "senso search", "senso org get", "senso whoami"],
    },
  );
}
