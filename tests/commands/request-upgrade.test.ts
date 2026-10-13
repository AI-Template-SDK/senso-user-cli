/**
 * Command layer: `senso request-upgrade`.
 *
 * One POST that notifies a person. What is worth protecting:
 *
 *   - the body, string for string. The partner's Upgrade Requests page labels a
 *     request by its `request_type` and its `category` and `intent` metadata,
 *     which are copied from the ZMP app; a drifted string is a request the team
 *     reads differently from the same request made in the app;
 *   - every mistake is caught before the request. A typo in the request name,
 *     a flag meant for another request, or an empty value exits 2 having
 *     notified nobody — a bad request here costs a human's attention;
 *   - "already requested" is a success. The API answers 200 with the open
 *     request instead of creating a second one, and the command must exit 0
 *     and say so, not treat it as a failure or a new request.
 */

import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../setup.js";
import { apiUrl, runCli } from "../helpers.js";

const PATH = "/org/credits/upgrade-request";

const RECORD = {
  request_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  org_id: "11111111-1111-4111-8111-111111111111",
  partner_id: "22222222-2222-4222-8222-222222222222",
  request_type: "upgrade-optimization.plan",
  request_source: "cli",
  metadata: {},
  created_at: "2026-10-13T09:30:00Z",
  updated_at: "2026-10-13T09:30:00Z",
};

/** Answers the POST with `status` and records every body sent. */
function upgradeEndpoint(status = 201, alreadyRequested = false): unknown[] {
  const bodies: unknown[] = [];
  server.use(
    http.post(apiUrl(PATH), async ({ request }) => {
      bodies.push(await request.json());
      if (status >= 400) {
        return HttpResponse.json({ status, message: "nope" }, { status });
      }
      return HttpResponse.json(
        {
          org_slug: "acme",
          org_name: "Acme",
          upgrade_request: RECORD,
          already_requested: alreadyRequested,
        },
        { status },
      );
    }),
  );
  return bodies;
}

describe("request-upgrade, refusing a request it cannot make sense of", () => {
  // No handler is registered in this block: MSW fails any request, so these
  // also prove nothing was sent.

  it("exits 2 on a request name it does not know, and lists the ones it does", async () => {
    const res = await runCli(["request-upgrade", "more-credits"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain('"more-credits"');
    expect(res.stderr).toContain("fix-answer-gaps");
    expect(res.stderr).toContain("activate-audience");
  });

  it("exits 2 when --persona is given with a request it does not apply to", async () => {
    const res = await runCli(["request-upgrade", "plan", "--persona", "CFOs"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--persona only applies to `activate-audience`");
  });

  it("exits 2 when --recommendation is given with a request it does not apply to", async () => {
    const res = await runCli(["request-upgrade", "activate-audience", "--recommendation", "x"]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("recommendation-help");
  });

  it("exits 2 on an empty --note", async () => {
    const res = await runCli(["request-upgrade", "--note", "   "]);

    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--note cannot be empty");
  });

  it("reports a usage error as JSON with the usage code", async () => {
    const res = await runCli(["request-upgrade", "nope", "--output", "json"]);

    expect(res.exitCode).toBe(2);
    expect(res.stdout).toBe("");
    expect(JSON.parse(res.stderr)).toMatchObject({ error: { code: "usage" } });
  });
});

describe("request-upgrade, when the API refuses", () => {
  it("exits 3 on a 401 and sends nothing to stdout", async () => {
    upgradeEndpoint(401);

    const res = await runCli(["request-upgrade"]);

    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe("");
  });

  it("exits 4 when the organization is not found", async () => {
    upgradeEndpoint(404);

    const res = await runCli(["request-upgrade"]);

    expect(res.exitCode).toBe(4);
  });

  it("exits 1 on a 400, which the checks above should have made impossible", async () => {
    upgradeEndpoint(400);

    const res = await runCli(["request-upgrade", "--output", "json"]);

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe("");
  });

  it("exits 3 without an API key, before any request", async () => {
    const res = await runCli(["request-upgrade"], { withKey: false });

    expect(res.exitCode).toBe(3);
  });
});

describe("request-upgrade, on the body it sends", () => {
  it("asks for the plan upgrade by default, as the app's Plan and usage page does", async () => {
    const bodies = upgradeEndpoint();

    const res = await runCli(["request-upgrade"]);

    expect(res.exitCode).toBe(0);
    expect(bodies).toEqual([
      {
        request_type: "upgrade-optimization.plan",
        request_source: "cli",
        metadata: {
          category: "Upgrade to Optimization",
          intent: "Move the workspace to Optimization",
        },
      },
    ]);
  });

  it("sends each feature upgrade with the app's feature, category and intent", async () => {
    const bodies = upgradeEndpoint();

    await runCli(["request-upgrade", "fix-answer-gaps"]);
    await runCli(["request-upgrade", "track-from-drafts"]);
    await runCli(["request-upgrade", "factual-accuracy"]);

    expect(bodies).toEqual([
      {
        request_type: "upgrade-optimization.fix-answer-gaps",
        request_source: "cli",
        metadata: {
          feature: "fix-gaps",
          category: "Upgrade to Optimization",
          intent: "Fix what AI answers were missing",
        },
      },
      {
        request_type: "upgrade-optimization.track-from-drafts",
        request_source: "cli",
        metadata: {
          feature: "drafts",
          category: "Upgrade to Optimization",
          intent: "Track a page from a Senso draft",
        },
      },
      {
        request_type: "upgrade-optimization.factual-accuracy",
        request_source: "cli",
        metadata: {
          feature: "factual-accuracy",
          category: "Upgrade to Optimization",
          intent: "See where AI answers get their facts wrong, and correct them",
        },
      },
    ]);
  });

  it("sends the Contact Zeta inquiries with their extra detail", async () => {
    const bodies = upgradeEndpoint();

    await runCli(["request-upgrade", "activate-audience", "--persona", "Small business owners"]);
    await runCli([
      "request-upgrade",
      "recommendation-help",
      "--recommendation",
      "Publish a pricing comparison page",
    ]);

    expect(bodies).toEqual([
      {
        request_type: "contact-zeta.activate-audience",
        request_source: "cli",
        metadata: {
          feature: "activate audience",
          category: "Contact Zeta",
          intent: "Reach an audience through Zeta's paid channels",
          persona: "Small business owners",
        },
      },
      {
        request_type: "contact-zeta.recommendation-help",
        request_source: "cli",
        metadata: {
          feature: "recommendation help",
          category: "Contact Zeta",
          intent: "Have the Zeta team help with a Feed recommendation",
          recommendation: "Publish a pricing comparison page",
        },
      },
    ]);
  });

  it("adds a trimmed --note to the metadata", async () => {
    const bodies = upgradeEndpoint();

    await runCli(["request-upgrade", "plan", "--note", "  Call Dana before Friday  "]);

    expect(bodies[0]).toMatchObject({ metadata: { note: "Call Dana before Friday" } });
  });

  it("accepts the request name in any case", async () => {
    const bodies = upgradeEndpoint();

    await runCli(["request-upgrade", "Fix-Answer-Gaps"]);

    expect(bodies[0]).toMatchObject({ request_type: "upgrade-optimization.fix-answer-gaps" });
  });
});

describe("request-upgrade, on what it reports", () => {
  it("confirms a new request on stderr and leaves stdout empty", async () => {
    upgradeEndpoint(201);

    const res = await runCli(["request-upgrade"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Request sent. The team will follow up.");
  });

  it("treats an open request of the same kind as a success, and says when it was made", async () => {
    upgradeEndpoint(200, true);

    const res = await runCli(["request-upgrade"]);

    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("You already asked for this on");
    expect(res.stderr).toContain("2026");
    expect(res.stderr).not.toContain("Request sent");
  });

  it("gives a JSON caller the request and whether it was new", async () => {
    upgradeEndpoint(201);

    const res = await runCli(["request-upgrade", "--output", "json"]);

    expect(res.json()).toEqual({
      requestId: RECORD.request_id,
      request: "plan",
      requestType: "upgrade-optimization.plan",
      category: "Upgrade to Optimization",
      alreadyRequested: false,
      createdAt: RECORD.created_at,
      orgName: "Acme",
    });
    expect(res.stderr).toBe("");
  });

  it("marks an existing request as such under --output json", async () => {
    upgradeEndpoint(200, true);

    const res = await runCli(["request-upgrade", "--output", "json"]);

    expect(res.json()).toMatchObject({ alreadyRequested: true });
  });

  it("confirms on stderr under --output table, like plain", async () => {
    upgradeEndpoint(201);

    const res = await runCli(["request-upgrade", "--output", "table"]);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Request sent.");
  });
});
