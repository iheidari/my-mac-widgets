// Linear — Übersicht desktop widget.
//
// Reads GET /stats/linear-stats from the local helper (src/providers/linear-stats/).
// Deploy with ./scripts/deploy.sh (copies this folder, and the shared kit it
// symlinks, into the Übersicht widgets directory).

import {
  statsCommand,
  parseOutput,
  refreshNow,
  baseCss,
  relTime,
  openUrl,
  Card,
  Grid,
  Tile,
  Foot,
  Section,
  Offline,
  Message,
} from "./kit.jsx";

const TITLE = "Linear";
const PROVIDER = "linear-stats";

// Übersicht's id for this file: the path under the widgets folder with every
// non-alphanumeric replaced by "-". Renaming the folder or this file changes it,
// and the ↻ button would then refresh nothing — so it is spelled out here rather
// than derived, where a rename is visible next to the rest of the widget.
const WIDGET_ID = "linear-stats-widget-index-jsx";

export const command = statsCommand(PROVIDER);

// The ↻ in the header: drop the helper's 5-minute cache and re-poll now.
const refresh = () => refreshNow(PROVIDER, WIDGET_ID);

// The helper caches for 5 minutes, so polling faster than this would only
// re-render the same numbers — this is how quickly a fresh poll reaches screen.
export const refreshFrequency = 60000; // 60s

// Middle of the left column: claude-stats is anchored to the top of it and
// system-status to the bottom, so centring keeps this clear of both regardless
// of how tall either grows.
export const className = `
  /* Right of claude-stats (left 40 + width 320 + 40 gutter), tops aligned, so
     the two never overlap however tall either card grows. */
  left: 400px;
  top: 40px;
  width: 320px;
  ${baseCss}

  .ln-rows { display: flex; flex-direction: column; gap: 2px; }
  .ln-row {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 10px; padding-top: 5px; padding-bottom: 5px;
  }
  .ln-name {
    font-size: 12px; color: #E5E7EB;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* Counts are tabular and fixed-width so the three columns line up down the
     list even though every project name is a different length. */
  .ln-counts {
    flex: none; font-size: 12px; font-variant-numeric: tabular-nums;
    color: var(--wk-muted); letter-spacing: 0.2px;
  }
  .ln-counts b { font-weight: 600; display: inline-block; width: 20px; text-align: right; }
  .ln-review { color: #C4B5FD; }
  .ln-backlog { color: #E5E7EB; }
  .ln-ready { color: var(--wk-ok); }
  .ln-zero { color: #545A66; }
  .ln-sep { padding: 0 3px; color: #4B5563; }
`;

// A count is dimmed at zero: with three numbers on every row, the eye should
// land on the ones that mean there is something to do.
const Count = ({ n, tone }) => <b className={n ? tone : "ln-zero"}>{n}</b>;

const ProjectRow = ({ row }) => (
  <div
    className={"ln-row" + (row.url ? " wk-click" : "")}
    onClick={row.url ? () => openUrl(row.url) : null}
    title={
      `${row.name} — ${row.review} in review, ${row.backlog} in backlog, ${row.ready} ready to play` +
      (row.url ? "\nClick to open in Linear" : "")
    }
  >
    <span className="ln-name">{row.name}</span>
    <span className="ln-counts">
      <Count n={row.review} tone="ln-review" />
      <span className="ln-sep">·</span>
      <Count n={row.backlog} tone="ln-backlog" />
      <span className="ln-sep">·</span>
      <Count n={row.ready} tone="ln-ready" />
    </span>
  </div>
);

export const render = ({ output }) => {
  const { offline, error, data } = parseOutput(output);
  if (offline) return <Offline title={TITLE} onRefresh={refresh} />;
  if (error) return <Message title={TITLE} onRefresh={refresh}>{error}</Message>;

  const rows = data.rows || [];
  // No rows and nothing retained: either no key is set up yet or the very first
  // poll failed. Either way the error text is the only useful thing to show.
  if (!rows.length) {
    return (
      <Message title={TITLE} onRefresh={refresh}>
        {data.error || "No projects to report."}
      </Message>
    );
  }

  const t = data.totals || { review: 0, backlog: 0, ready: 0 };
  const stale = Boolean(data.stale);

  return (
    <Card
      title={TITLE}
      live={data.available === true}
      dotTitle={stale ? `Last poll failed — ${data.error || "unknown error"}` : "Live"}
      onRefresh={refresh}
    >
      <Grid columns={3}>
        <Tile value={t.review} label="Review" color="#C4B5FD" />
        <Tile value={t.backlog} label="Backlog" />
        <Tile value={t.ready} label="Ready" color="var(--wk-ok)" />
      </Grid>

      <Section dim={stale} note={stale ? relTime(data.staleSince) : null} noteTitle={stale ? data.error : null}>
        <div className="ln-rows">
          {rows.map((row) => (
            <ProjectRow key={row.id || "unassigned"} row={row} />
          ))}
        </div>
      </Section>

      {/* The review column matches a state by name, so a renamed status would
          silently report zero. Say so rather than let the number lie. */}
      {data.reviewStateKnown === false && (
        <Section>
          <div className="wk-message">
            No workflow state named <code>{(data.reviewStates || []).join(", ")}</code> — set{" "}
            <code>LINEAR_STATS_REVIEW_STATES</code>.
          </div>
        </Section>
      )}

      <Foot left={relTime(data.updatedAt, "updated")} right={`${t.projects || rows.length} projects`} />
    </Card>
  );
};
