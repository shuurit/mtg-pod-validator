/**
 * Relay Worker for the "Games to Update" tab.
 *
 * Holds ONE secret (GITHUB_TOKEN, set via `wrangler secret put GITHUB_TOKEN`
 * or the Cloudflare dashboard -- never in this source file) and does exactly
 * one thing with it: fire a repository_dispatch event at the mtg-pod-validator
 * repo. It never touches repo contents directly -- the GitHub Actions
 * workflow does the actual file edit, using GitHub's own auto-issued token
 * for that run.
 *
 * Deploy with: wrangler deploy
 */

const GITHUB_OWNER = "shuurit";
const GITHUB_REPO = "mtg-pod-validator";
const ALLOWED_ORIGIN = "https://shuurit.github.io";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function isValidPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (typeof payload.date !== "string") return false;
  if (typeof payload.podSize !== "number") return false;
  if (!Array.isArray(payload.participants)) return false;
  if (payload.participants.length !== payload.podSize) return false;
  const requiredFields = [
    "player", "commander", "strength", "result", "place", "knockouts",
    "tov", "popOff", "disruptions", "recoveries", "gamesClearlyBehind", "bracket",
  ];
  return payload.participants.every(p =>
    p && typeof p === "object" && requiredFields.every(f => f in p)
  );
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    if (!isValidPayload(payload)) {
      return new Response(JSON.stringify({ error: "Payload missing required fields" }), {
        status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    const dispatchRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
          "Accept": "application/vnd.github+json",
          "User-Agent": "mtg-pod-validator-relay",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "add-game",
          client_payload: payload,
        }),
      }
    );

    if (dispatchRes.status !== 204) {
      const errText = await dispatchRes.text();
      return new Response(JSON.stringify({ error: "GitHub dispatch failed", detail: errText }), {
        status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 202, headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  },
};
