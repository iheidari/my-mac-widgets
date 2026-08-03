'use strict';

// Pure shaping: a Linear GraphQL response in, the widget's payload out.
//
// Kept free of fetching and caching so the counting rules — which are the part
// that is easy to get subtly wrong — can be tested against fixtures with no
// network, no credential and no clock.

// "In Review" is matched by state NAME, not type: Linear types both `In Progress`
// and `In Review` as `started`, so the type carries no way to tell them apart.
// That makes the column sensitive to renaming the state, which is why the payload
// reports whether the workspace actually has a matching state (see reviewStateKnown).
const DEFAULT_REVIEW_STATES = ['In Review'];

// The backlog column means "what Linear shows on its Backlog page" — the
// `backlog` type — plus `unstarted` (the `Todo` status), which the user counts
// as backlog even though Linear files it under Active.
const BACKLOG_STATE_TYPES = new Set(['backlog', 'unstarted']);

const DEFAULT_READY_LABEL = 'Ready to play';

// Project statuses that mean "this project is over" — no row for it.
const CLOSED_PROJECT_TYPES = new Set(['completed', 'canceled']);

const UNKNOWN_PROJECT_NAME = '— no project';

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

// Env is read per call, not at load, so a test can flip it between cases.
function config(env = process.env) {
  const raw = env.LINEAR_STATS_REVIEW_STATES;
  const reviewStates = raw
    ? String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_REVIEW_STATES;
  return {
    reviewStates,
    readyLabel: env.LINEAR_STATS_READY_LABEL || DEFAULT_READY_LABEL,
  };
}

function projectIsOpen(project) {
  // `status.type` is the current field; `state` is the deprecated string that
  // older workspaces still answer with. Unknown → treat as open, since hiding a
  // project the user can see in Linear is worse than showing a finished one.
  const type = norm((project.status && project.status.type) || project.state);
  return !CLOSED_PROJECT_TYPES.has(type);
}

function hasLabel(issue, wanted) {
  const nodes = (issue.labels && issue.labels.nodes) || [];
  return nodes.some((l) => l && norm(l.name) === wanted);
}

// Rows are ordered busiest-first: biggest backlog, then most in review, then
// name — so the list only reshuffles when the numbers actually change.
function compareRows(a, b) {
  return b.backlog - a.backlog || b.review - a.review || a.name.localeCompare(b.name);
}

function aggregate({ projects = [], states = [], issues = [] }, env = process.env) {
  const { reviewStates, readyLabel } = config(env);
  const reviewSet = new Set(reviewStates.map(norm));
  const wantedLabel = norm(readyLabel);

  const rows = new Map();
  const blank = (id, name, url) => ({ id, name, url: url || null, review: 0, backlog: 0, ready: 0 });

  // Seed every open project so one with no issues still gets a row at 0/0/0 —
  // an absent row would read as "no such project" rather than "nothing to do".
  for (const p of projects) {
    if (!p || !p.id || !projectIsOpen(p)) continue;
    rows.set(p.id, blank(p.id, p.name || p.id, p.url));
  }

  // Issues with no project land in one pseudo-row, dropped below if it stays empty.
  const UNASSIGNED = '@unassigned';

  for (const issue of issues) {
    if (!issue || !issue.state) continue;
    const projectId = (issue.project && issue.project.id) || UNASSIGNED;
    let row = rows.get(projectId);
    if (!row) {
      // An issue whose project has no row — it belongs to a completed/canceled
      // project we deliberately dropped. Skip it: it must not resurface under a
      // heading that claims it has no project.
      if (projectId !== UNASSIGNED) continue;
      row = blank(null, UNKNOWN_PROJECT_NAME, null);
      rows.set(UNASSIGNED, row);
    }

    const type = norm(issue.state.type);
    if (BACKLOG_STATE_TYPES.has(type)) {
      row.backlog += 1;
      // "Ready" is a subset of backlog, never a third independent bucket — an
      // In Review issue carrying the label must not inflate it.
      if (hasLabel(issue, wantedLabel)) row.ready += 1;
    } else if (reviewSet.has(norm(issue.state.name))) {
      row.review += 1;
    }
  }

  const unassigned = rows.get(UNASSIGNED);
  if (unassigned && !unassigned.review && !unassigned.backlog && !unassigned.ready) rows.delete(UNASSIGNED);

  const list = Array.from(rows.values()).sort(compareRows);
  const totals = list.reduce(
    (acc, r) => ({
      review: acc.review + r.review,
      backlog: acc.backlog + r.backlog,
      ready: acc.ready + r.ready,
      // The unassigned pseudo-row is a bucket, not a project — counting it would
      // report one more project than the workspace has.
      projects: acc.projects + (r.id ? 1 : 0),
    }),
    { review: 0, backlog: 0, ready: 0, projects: 0 }
  );

  // Does the workspace still have a state by the name the review column matches?
  // If not, that column reads 0 for a reason the numbers can't show — someone
  // renamed the status — so the widget flags it instead of quietly reporting zero.
  const reviewStateKnown = states.length === 0 || states.some((s) => s && reviewSet.has(norm(s.name)));

  return { rows: list, totals, reviewStates, readyLabel, reviewStateKnown };
}

module.exports = {
  aggregate,
  config,
  compareRows,
  DEFAULT_REVIEW_STATES,
  DEFAULT_READY_LABEL,
  BACKLOG_STATE_TYPES,
  UNKNOWN_PROJECT_NAME,
};
