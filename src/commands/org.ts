import { Command } from "commander";
import { ApiError, apiRequest } from "../lib/api-client.js";
import { CliError, EXIT, usageError } from "../lib/errors.js";
import { describeCommand, idExits } from "../lib/help.js";
import { parseId } from "../lib/id-arg.js";
import { parseJsonFlag } from "../lib/json-arg.js";
import { emit } from "../lib/output.js";
import type { NextStep } from "../lib/output.js";
import type { ResourceRef } from "../lib/resource.js";
import { runAction } from "../lib/run-action.js";
import * as log from "../utils/logger.js";

/**
 * Every command in this group addresses the key's own organization: there is no
 * org id anywhere, and a 404 therefore means the key outlived its org.
 */
const ORG: ResourceRef = { type: "Organization", list: "senso whoami" };

/** The catalog `org set-industry` picks from. A per-catalog id, not a name. */
const INDUSTRY: ResourceRef = {
  type: "Industry",
  idField: "industry_id",
  list: "senso industries list",
};

/** The two fields of `websites`/`locations` the CLI reads to report a removal. */
interface OrgWebsite {
  org_website_id?: string;
  url?: string;
}

interface OrgLocation {
  org_location_id?: string;
  country_code?: string;
  region_name?: string;
}

interface OrgRecord {
  industry_id?: string;
  websites?: OrgWebsite[];
  locations?: OrgLocation[];
}

interface UpdateOrgBody {
  name?: unknown;
  slug?: unknown;
  logo_url?: unknown;
  websites?: unknown;
  locations?: unknown;
}

/**
 * The accepted keys, from UpdateOrgSelfRequest's binding tags.
 *
 * Named here rather than trusted to the API because the Go binder drops keys it
 * does not recognize instead of rejecting them: `--data '{"website": …}'` is a
 * 200 that changed nothing, which reads as success.
 */
const UPDATE_KEYS = ["name", "slug", "logo_url", "websites", "locations"] as const;

/** A website entry takes only `url`; `org_website_id` from `org get` is dropped. */
const WEBSITE_KEYS = ["url"] as const;

/** A location entry, from the same DTO. `country_code` is exactly two letters. */
const LOCATION_KEYS = ["country_code", "region_name"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks one list of entries before the request.
 *
 * The API answers a bad entry with `{"field":"url","message":"Invalid value"}` —
 * no index, no path, no rule — and silently drops any key it does not know. So
 * the entry shape is checked here, where the message can name
 * `--data.websites[0].org_website_id` and say what the accepted keys are.
 */
function validateEntries(
  field: "websites" | "locations",
  value: unknown,
  accepted: readonly string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw usageError(`--data.${field} must be an array.`, {
      field: `--data.${field}`,
      received: JSON.stringify(value),
      hint:
        field === "websites"
          ? `Example: --data '{"websites": [{"url": "https://acme.com"}]}'. Pass [] to clear the list.`
          : `Example: --data '{"locations": [{"country_code": "US", "region_name": "California"}]}'. Pass [] to clear the list.`,
    });
  }

  value.forEach((entry, i) => {
    const at = `--data.${field}[${String(i)}]`;
    if (!isRecord(entry)) {
      throw usageError(`${at} must be an object.`, {
        field: at,
        received: JSON.stringify(entry),
        allowed: accepted,
      });
    }

    const unknown = Object.keys(entry).filter((k) => !accepted.includes(k));
    const offender = unknown[0] ?? "";
    if (unknown.length > 0) {
      throw usageError(
        `${at}.${offender} is not an accepted key; ${field === "websites" ? "a website entry takes only url" : "a location entry takes country_code and region_name"}.`,
        {
          field: `${at}.${offender}`,
          received: JSON.stringify(entry[offender]),
          allowed: accepted,
          // The ids in `org get` look round-trippable and are not: the binder
          // drops them, so the caller would believe the id was honored.
          hint: `The API ignores keys it does not recognize. Send only ${accepted.join(", ")}: senso org get --output json | jq '.data.${field} | map({${accepted.join(", ")}})'`,
        },
      );
    }

    if (field === "websites") {
      const url = entry.url;
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        throw usageError(`${at}.url must be an http(s) URL.`, {
          field: `${at}.url`,
          received: typeof url === "string" ? url : JSON.stringify(url),
          hint: 'Example: {"url": "https://acme.com"}',
        });
      }
      return;
    }

    const code = entry.country_code;
    if (typeof code !== "string" || !/^[A-Za-z]{2}$/.test(code)) {
      throw usageError(`${at}.country_code must be a 2-letter ISO 3166-1 code.`, {
        field: `${at}.country_code`,
        received: typeof code === "string" ? code : JSON.stringify(code),
        hint: 'Example: {"country_code": "US", "region_name": "California"}',
      });
    }
  });
}

/** "https://old.example" / "US/California" — how a removed entry is named. */
function websiteLabel(w: OrgWebsite): string {
  return w.url ?? w.org_website_id ?? "(unnamed website)";
}

function locationLabel(l: OrgLocation): string {
  const code = l.country_code ?? "??";
  return l.region_name ? `${code}/${l.region_name}` : code;
}

/** Entries that were in the organization before the write and are not in it after. */
function removed<T>(before: T[], after: T[], label: (item: T) => string): string[] {
  const kept = new Set(after.map((item) => label(item).toLowerCase()));
  return before.map(label).filter((name) => !kept.has(name.toLowerCase()));
}

/**
 * What a `websites`/`locations` write silently deleted.
 *
 * This is the one destructive-by-omission call in the group: the API replaces
 * the whole list, so sending one website deletes the rest, and the response is
 * a 200 carrying the shortened list. Nothing in the old output said so. The
 * previous record is read before the write purely so this sentence can name the
 * entries that are now gone.
 */
function replacementWarnings(
  body: UpdateOrgBody,
  before: OrgRecord | undefined,
  after: OrgRecord,
): string[] {
  const warnings: string[] = [];

  const fields = [
    {
      key: "websites" as const,
      beforeList: before?.websites ?? [],
      afterList: after.websites ?? [],
      label: websiteLabel,
    },
    {
      key: "locations" as const,
      beforeList: before?.locations ?? [],
      afterList: after.locations ?? [],
      label: locationLabel,
    },
  ];

  for (const field of fields) {
    if (body[field.key] === undefined) continue;

    if (!before) {
      warnings.push(
        `${field.key} replaced the whole list. The previous list could not be read, so any entry you left out is gone without being named here.`,
      );
      continue;
    }

    // `label` is typed per field above; the cast is what lets one loop serve
    // two element types rather than duplicating the block.
    const gone = removed(
      field.beforeList as unknown[],
      field.afterList as unknown[],
      field.label as (item: unknown) => string,
    );
    if (gone.length > 0) {
      warnings.push(
        `${field.key} replaced the whole list: ${String(gone.length)} ${gone.length === 1 ? "entry" : "entries"} removed (${gone.join(", ")}).`,
      );
    }
  }

  return warnings;
}

export function registerOrgCommands(program: Command): void {
  const org = program
    .command("org")
    .description(
      "Read and change the organization your API key belongs to. There is no organization id to pass — every command here acts on the key's own organization (see `senso whoami`). Workflow: `org get` reads the record, `org update` changes name/slug/logo and REPLACES the websites and locations lists, `org set-industry` picks an industry from `senso industries list` once and for all, `org set-runs` is the org-wide pause switch for every scheduled run.",
    );

  describeCommand(
    org
      .command("get")
      .description(
        "Read the organization your API key belongs to: name, slug, logo, websites, locations, industry, AI models, schedules and the org-wide runs switch. Read-only.",
      )
      .action(
        runAction(program, async (ctx) => {
          const data = await apiRequest<OrgRecord>({
            path: "/org/me",
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: ORG,
          });

          const next: NextStep[] = [
            {
              why: "Change name, slug, logo, websites or locations",
              command: `senso org update --data '{"name":"…"}'`,
            },
          ];
          if (!data.industry_id) {
            next.push({
              why: "This organization has no industry yet; it can be set once",
              command: "senso org set-industry <industry_id>",
            });
          }
          emit(ctx, data, { next });
        }),
      ),
    {
      returns: [
        "org_id — the organization's id, also reported by `senso whoami`",
        "name, slug — display name and URL slug; change them with `senso org update`",
        "logo_url — absent when no logo is set",
        "websites[] — {org_website_id, url}. Absent when there are none. org_website_id is read-only: `org update` takes only url",
        "locations[] — {org_location_id, country_code, region_name}. Absent when there are none",
        "industry_id / industry_name — absent until `senso org set-industry` is run",
        "models[] — {geo_model_id, name}. Configured by your partner; read-only here",
        "schedule[] / content_schedule[] — weekdays runs are scheduled on: 0 = Sunday, 1 = Monday, 2 = Tuesday, 3 = Wednesday, 4 = Thursday, 5 = Friday, 6 = Saturday",
        "enable_runs — true | false. false means every scheduled run is paused (`senso org set-runs`)",
        "is_free_tier — true | false. true means spend is billed to the partner, against spend_limit; see `senso credits balance`",
        "is_activated — true | false. true once onboarding finished",
      ],
      exitCodes: {
        ...idExits,
        4: "the organization this key belongs to no longer exists",
      },
      examples: [
        { comment: "The whole record", command: "senso org get" },
        {
          comment: "Just the owned domains",
          command: "senso org get --output json | jq -r '.data.websites[].url'",
        },
      ],
      seeAlso: ["senso whoami", "senso org update", "senso credits balance"],
      notes: [
        "Empty lists are omitted rather than returned as []: no `websites` key means no websites.",
      ],
    },
  );

  describeCommand(
    org
      .command("update")
      .description(
        "Change the organization's name, slug, logo, websites or locations. Only the keys you pass are changed, but `websites` and `locations` REPLACE their whole list: every entry you leave out is deleted. Returns the organization record after the write, and warns about the entries the write removed.",
      )
      .requiredOption(
        "--data <json>",
        'JSON object with any of: "name" (1-255), "slug" (1-255, unique across Senso), "logo_url" ("" clears it), "websites" ([{"url":"https://acme.com"}], the FULL list; [] clears it; an entry takes only url), "locations" ([{"country_code":"US","region_name":"California"}], the FULL list; country_code is exactly 2 letters). Unknown keys exit 2 before any request.',
      )
      .action(
        runAction(program, async (ctx, cmdOpts: { data: string }) => {
          const body = parseJsonFlag<UpdateOrgBody>(cmdOpts.data, {
            optional: UPDATE_KEYS,
            rejectEmpty:
              "Name at least one of: name, slug, logo_url, websites, locations. An empty object would change nothing.",
          });
          validateEntries("websites", body.websites, WEBSITE_KEYS);
          validateEntries("locations", body.locations, LOCATION_KEYS);

          // Read before writing, and only when a replacing key is present: this
          // is the only way to name what the replacement deleted, and a caller
          // who is not touching either list should not pay for the extra call.
          const replacing = body.websites !== undefined || body.locations !== undefined;
          const before = replacing ? await readOrgQuietly(ctx) : undefined;

          const data = await apiRequest<OrgRecord>({
            method: "PUT",
            path: "/org/me",
            body,
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: ORG,
          });

          if (!ctx.quiet) log.success("Organization updated.");
          emit(ctx, data, {
            warnings: replacementWarnings(body, before, data),
            next: [{ why: "Confirm the stored record", command: "senso org get" }],
          });
        }),
      ),
    {
      returns: [
        "The organization record, the same shape as `senso org get`.",
        "warnings[] — one entry per list that was replaced, naming the entries this write removed.",
      ],
      exitCodes: {
        ...idExits,
        2: "--data is not a JSON object, carries an unknown key, or has a bad url/country_code",
        1: "the API refused: 409 when the slug is already taken by another organization",
        4: "the organization this key belongs to no longer exists",
      },
      examples: [
        {
          comment: "Rename the organization",
          command: `senso org update --data '{"name":"Acme Inc"}'`,
        },
        {
          comment: "Add a website without deleting the others: send the full list",
          command: `senso org update --data '{"websites":[{"url":"https://acme.com"},{"url":"https://blog.acme.com"}]}'`,
        },
        {
          comment: "See what a replacement removed",
          command: `senso org update --data '{"websites":[{"url":"https://acme.com"}]}' --output json | jq .warnings`,
        },
      ],
      seeAlso: ["senso org get"],
      notes: [
        "`websites` and `locations` are replaced wholesale. Run `senso org get` first and send back every entry you want to keep.",
        "org_website_id and org_location_id are read-only: entries take only the fields listed above, and the API drops anything else without saying so.",
      ],
    },
  );

  describeCommand(
    org
      .command("set-industry")
      .description(
        "Point the organization at an industry from the public catalog. This can be done ONCE: a second call is refused and changing it afterwards is not self-serve. The industry is what `senso industries import-prompts` and `senso generate industry-draft` work from, and where an org with no models or locations of its own inherits them on activation. Nothing else happens — no prompts are created and no runs start.",
      )
      .argument(
        "<industryId>",
        "industry_id (UUID) from `senso industries list`, not an industry name",
      )
      .action(
        runAction(program, async (ctx, industryIdArg: string) => {
          const industryId = parseId(industryIdArg, { ...INDUSTRY, label: "<industryId>" });
          try {
            const data = await apiRequest({
              method: "PUT",
              path: "/org/me/industry",
              body: { industry_id: industryId },
              apiKey: ctx.apiKey,
              baseUrl: ctx.baseUrl,
              resource: { ...INDUSTRY, id: industryId },
            });
            if (!ctx.quiet) log.success("Organization industry set.");
            emit(ctx, data, {
              next: [
                {
                  why: "Copy the industry's tracked prompts into this organization",
                  command: `senso industries import-prompts ${industryId}`,
                },
              ],
            });
          } catch (err) {
            // A 409 here is not a generic conflict: the industry is already set
            // and no flag or retry will change it. Say so, rather than leaving the
            // caller to retry a call that can never succeed.
            if (err instanceof ApiError && err.status === 409) {
              // The server names the industry already in place, which is the one
              // detail worth keeping — pass it through rather than flattening it.
              throw new CliError(err.message, EXIT.ERROR, {
                code: "conflict",
                status: 409,
                hint: "An industry can be set only once, and changing it afterwards is not self-serve — contact Senso support. Run `senso org get` to see the industry this organization already has.",
                cause: err,
              });
            }
            throw err;
          }
        }),
      ),
    {
      returns: [
        "The organization record (see `senso org get`) with industry_id and industry_name set.",
      ],
      exitCodes: {
        ...idExits,
        2: "<industryId> is not a UUID",
        4: "no industry in the public catalog has this id (a partner-private industry also 404s)",
        1: "409: the industry is already set and cannot be changed",
      },
      examples: [
        {
          comment: "Find the id first",
          command: `senso industries list --output json | jq -r '.data[] | "\\(.industry_id)  \\(.name)"'`,
        },
        {
          command: "senso org set-industry 5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f",
        },
      ],
      seeAlso: ["senso industries list", "senso industries import-prompts", "senso org get"],
      notes: ["One-way: the API accepts this once and refuses every later attempt with a 409."],
    },
  );

  describeCommand(
    org
      .command("set-runs")
      .description(
        "Flip the organization-wide runs master switch (the `enable_runs` field of `senso org get`). false pauses every scheduled prompt run and content-generation run; true resumes the schedule. Runs already in progress are not canceled.",
      )
      .requiredOption("--enabled <bool>", "true or false. Maps to the API field enable_runs")
      .action(
        runAction(program, async (ctx, cmdOpts: { enabled: string }) => {
          const raw = cmdOpts.enabled.trim().toLowerCase();
          if (raw !== "true" && raw !== "false") {
            throw usageError("--enabled must be `true` or `false`.", {
              field: "--enabled",
              received: cmdOpts.enabled,
              allowed: ["true", "false"],
              hint: "Pass --enabled true or --enabled false.",
            });
          }
          const enable = raw === "true";
          const data = await apiRequest({
            method: "PATCH",
            path: "/org/me/runs-enabled",
            body: { enable_runs: enable },
            apiKey: ctx.apiKey,
            baseUrl: ctx.baseUrl,
            resource: ORG,
          });
          if (!ctx.quiet) {
            log.success(
              `Org-wide runs ${enable ? "enabled" : "disabled"} (enable_runs=${String(enable)}).`,
            );
          }
          emit(ctx, data, {
            next: [
              {
                why: enable ? "Pause every scheduled run again" : "Resume scheduled runs later",
                command: `senso org set-runs --enabled ${enable ? "false" : "true"}`,
              },
            ],
          });
        }),
      ),
    {
      returns: [
        "The organization record (see `senso org get`); enable_runs is the field this command changed.",
        "enable_runs — true | false",
      ],
      exitCodes: {
        ...idExits,
        2: "--enabled is not true or false",
        4: "the organization this key belongs to no longer exists",
      },
      examples: [
        { comment: "Pause every scheduled run", command: "senso org set-runs --enabled false" },
        {
          command: "senso org set-runs --enabled true --output json | jq .data.enable_runs",
        },
      ],
      seeAlso: ["senso org get", "senso prompts list"],
      notes: ["This is a schedule switch. It does not cancel a run that is already in progress."],
    },
  );
}

/**
 * The organization as it is now, or `undefined` when it cannot be read.
 *
 * Only used to describe what a replacement removed, so a failure here must not
 * fail the update the caller asked for — the write is reported either way, and
 * `replacementWarnings` says when the comparison was not possible.
 */
async function readOrgQuietly(ctx: {
  apiKey?: string;
  baseUrl?: string;
}): Promise<OrgRecord | undefined> {
  try {
    return await apiRequest<OrgRecord>({
      path: "/org/me",
      apiKey: ctx.apiKey,
      baseUrl: ctx.baseUrl,
      resource: ORG,
    });
  } catch {
    return undefined;
  }
}
