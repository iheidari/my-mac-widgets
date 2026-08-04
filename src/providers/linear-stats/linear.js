'use strict';

// Minimal Linear GraphQL client — two requests per refresh, no SDK.
//
// We talk to the documented public API (api.linear.app/graphql) rather than
// shelling out to the `linearis` CLI: the CLI stores an encrypted token we
// cannot reuse, and its issue payload omits `state.type`, which is exactly the
// field the backlog column is defined by.
//
// Everything here resolves to a normalized result object instead of throwing —
// classification lives in index.js, and a thrown collect() would 500 the widget.

const API_URL = 'https://api.linear.app/graphql';

// Issues are fetched a page at a time. Linear rejects requests over a server-side
// complexity budget ("Query too complex"), and that budget counts nested
// selections — so page size and the label sub-selection are deliberately modest
// rather than the API's 250 maximum. 50 is ~2 requests for a workspace this size.
const PAGE_SIZE = 50;
const LABELS_PER_ISSUE = 20;

// Only these state types can contribute to a column: `backlog`+`unstarted` feed
// the backlog count, `started` feeds In Review. Filtering server-side keeps
// completed/canceled/duplicate issues — the bulk of a mature workspace — out of
// the response entirely instead of paging through them to discard them.
const COUNTED_STATE_TYPES = ['backlog', 'unstarted', 'started'];

const WORKSPACE_QUERY = `
  query WidgetWorkspace {
    projects(first: 250) {
      nodes { id name url state status { type } }
    }
    workflowStates(first: 250) {
      nodes { id name type }
    }
  }
`;

const ISSUES_QUERY = `
  query WidgetIssues($after: String, $first: Int!, $types: [String!]!) {
    issues(first: $first, after: $after, filter: { state: { type: { in: $types } } }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        state { name type }
        project { id }
        labels(first: ${LABELS_PER_ISSUE}) { nodes { name } }
      }
    }
  }
`;

// One GraphQL POST. Resolves { status, json } or { error } — never rejects.
async function post(apiKey, query, variables, timeoutMs = 10_000) {
  let res;
  try {
    // Resolved from the global at call time so tests can stub it.
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        // Linear personal API keys go in Authorization verbatim — no "Bearer".
        authorization: apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const msg = String((err && err.message) || err);
    return { error: err && err.name === 'TimeoutError' ? 'Linear request timed out' : msg };
  }

  const body = await res.text().catch(() => '');
  if (res.status !== 200) return { status: res.status, error: `Linear API returned ${res.status}` };

  let json;
  try {
    json = JSON.parse(body);
  } catch (_) {
    return { status: res.status, error: 'Linear API returned non-JSON' };
  }
  // GraphQL reports auth failures and complexity rejections as 200 + errors[],
  // so a status check alone is not enough to call a response successful.
  if (json.errors && json.errors.length) {
    return { status: res.status, error: graphqlError(json.errors) };
  }
  return { status: res.status, json: json.data || {} };
}

function graphqlError(errors) {
  const first = errors[0] || {};
  const msg = first.message || 'unknown GraphQL error';
  // Linear tags auth failures in extensions.code; surface it so index.js can
  // back off on a revoked key instead of retrying it like a network blip.
  const code = (first.extensions && first.extensions.code) || null;
  return code ? `${msg} (${code})` : msg;
}

function isAuthError(message) {
  return /AUTHENTICATION|authentication|Unauthorized|invalid api key/i.test(String(message || ''));
}

// Fetch every counted issue, following the cursor. Stops at MAX_PAGES so a
// filter that unexpectedly matches a huge workspace can't spin forever.
async function fetchIssues(apiKey, maxPages = 40) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await post(apiKey, ISSUES_QUERY, { after, first: PAGE_SIZE, types: COUNTED_STATE_TYPES });
    if (res.error) return { error: res.error, status: res.status };
    const conn = (res.json && res.json.issues) || {};
    for (const n of conn.nodes || []) nodes.push(n);
    const info = conn.pageInfo || {};
    if (!info.hasNextPage || !info.endCursor) return { nodes };
    after = info.endCursor;
  }
  // Truncated rather than failed: partial counts beat an empty widget, but say so.
  return { nodes, truncated: true };
}

// Both requests for one refresh. Resolves { projects, states, issues } or { error }.
async function fetchWorkspace(apiKey) {
  const ws = await post(apiKey, WORKSPACE_QUERY, {});
  if (ws.error) return { error: ws.error, status: ws.status };

  const issues = await fetchIssues(apiKey);
  if (issues.error) return { error: issues.error, status: issues.status };

  return {
    projects: (ws.json.projects && ws.json.projects.nodes) || [],
    states: (ws.json.workflowStates && ws.json.workflowStates.nodes) || [],
    issues: issues.nodes,
    truncated: issues.truncated || false,
  };
}

module.exports = { fetchWorkspace, fetchIssues, post, isAuthError, API_URL, PAGE_SIZE, COUNTED_STATE_TYPES };
