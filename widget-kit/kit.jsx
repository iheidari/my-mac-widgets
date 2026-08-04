// Shared Übersicht widget kit.
//
// Every widget in this repo imports this file, so a new one is a data shape
// plus a layout rather than another 300 lines of CSS. It is deployed *into*
// each widget bundle (widgets/<name>.widget/kit.jsx is a symlink to this file,
// and scripts/deploy.sh dereferences it) because Übersicht bundles each widget
// folder independently with browserify.
//
// Übersicht compiles JSX with the pragma `html` (= React.createElement), which
// it exposes as a true global — so components defined here work exactly as they
// do in a widget's own file. Avoid JSX fragments (<>...</>): the fragment
// pragma resolves to `React.Fragment`, which is *not* global.

// `run` executes a shell command from the widget. Übersicht marks "uebersicht"
// external when it bundles a widget and supplies it at runtime, so importing it
// here — in the shared kit — resolves exactly as it would in a widget's own file.
import { run } from "uebersicht";

const DEFAULT_PORT = 4318; // must match WIDGET_HOST_PORT in the helper
const DEFAULT_HOST = "127.0.0.1";

// Sentinel echoed when curl fails, so `render` can tell "helper down" from
// "helper returned nothing".
const OFFLINE = "__OFFLINE__";

// Build the `command` a widget exports. `provider` is the id of a folder under
// src/providers/ — omit it to hit the default provider at /stats.
export function statsCommand(provider, { port = DEFAULT_PORT, host = DEFAULT_HOST, timeout = 4 } = {}) {
  const path = provider ? `/stats/${provider}` : "/stats";
  return `curl -s --max-time ${timeout} http://${host}:${port}${path} || echo '${OFFLINE}'`;
}

// Normalize a widget's raw `output` into { offline, error, data }.
export function parseOutput(output) {
  if (!output || output.indexOf(OFFLINE) !== -1) return { offline: true, error: null, data: null };
  try {
    return { offline: false, error: null, data: JSON.parse(output) };
  } catch (e) {
    return { offline: false, error: "Could not parse helper response.", data: null };
  }
}

// -------------------------------------------------------------- interaction

// Open a URL in the default browser. `run` goes through a shell, so the URL is
// single-quoted rather than interpolated bare: these strings come back from an
// API, and one containing a backtick or $(…) would otherwise execute.
export function openUrl(url) {
  if (!url) return;
  const quoted = "'" + String(url).replace(/'/g, "'\\''") + "'";
  run(`open ${quoted}`);
}

// ---------------------------------------------------------------- formatting

export function fmt(n) {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

export function usd(n) {
  if (n == null) return "—";
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function hour(h) {
  if (h == null) return "—";
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${ampm}`;
}

// "as of 12m ago" — for any reading a widget is showing past its freshness.
export function relTime(iso, prefix = "as of") {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return "stale";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return `${prefix} just now`;
  if (mins < 60) return `${prefix} ${mins}m ago`;
  return `${prefix} ${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

// Green below 75%, amber to 90%, red past it — the usual "how close am I to a
// ceiling" ramp. Widgets that mean something else by percent pass their own.
export function pctColor(pct) {
  if (pct >= 90) return "#EF4444";
  if (pct >= 75) return "#FBBF24";
  return "#3B82F6";
}

// ---------------------------------------------------------------------- css

// Layout/typography shared by every widget. Widgets prepend their own
// positioning (top/left/width) and may override any --wk-* variable.
export const baseCss = `
  font-family: -apple-system, "SF Pro Display", "Helvetica Neue", sans-serif;
  color: var(--wk-fg, #ECECEC);
  -webkit-font-smoothing: antialiased;

  --wk-muted: #9AA0AA;
  --wk-accent: #C4B5FD;
  /* Binary good/bad states, for widgets that report a condition rather than a
     percentage (pctColor covers the percentage ramp). Same values as .wk-live
     and pctColor's red, so a widget's tiles match its status dot. */
  --wk-ok: #4ADE80;
  --wk-bad: #EF4444;

  .wk-card {
    background: rgba(20, 22, 28, 0.72);
    backdrop-filter: blur(24px) saturate(140%);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 18px;
    padding: 18px 20px 16px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  }
  .wk-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }
  .wk-title { font-size: 14px; font-weight: 600; letter-spacing: 0.2px; }
  .wk-dot {
    width: 8px; height: 8px; border-radius: 50%;
    box-shadow: 0 0 8px currentColor;
  }
  .wk-live { color: #4ADE80; }
  .wk-idle { color: #6B7280; box-shadow: none; }

  .wk-grid { display: grid; gap: 10px; }
  .wk-tile {
    background: rgba(255, 255, 255, 0.045);
    border-radius: 12px;
    padding: 10px 12px;
  }
  .wk-tile .v {
    font-size: 20px; font-weight: 700; line-height: 1.1;
    font-variant-numeric: tabular-nums;
  }
  .wk-tile .l {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px;
    color: var(--wk-muted); margin-top: 3px;
  }

  .wk-foot {
    display: flex; justify-content: space-between; align-items: center;
    margin-top: 12px; padding-top: 10px;
    border-top: 1px solid rgba(255,255,255,0.07);
    font-size: 11px; color: var(--wk-muted);
  }
  .wk-foot .accent { color: var(--wk-accent); font-weight: 600; }

  .wk-section { margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.07); }
  .wk-section-title {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.7px;
    color: var(--wk-muted); margin-bottom: 10px;
    display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
  }
  /* A retained last-good reading: dimmed so it never reads as a live number. */
  .wk-dim { opacity: 0.55; }
  .wk-note { text-transform: none; letter-spacing: 0; color: #C08A4A; }

  .wk-bar-row { margin-bottom: 11px; }
  .wk-bar-row:last-child { margin-bottom: 2px; }
  .wk-bar-head {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-bottom: 5px;
  }
  .wk-bar-label { font-size: 12px; font-weight: 600; color: #E5E7EB; }
  .wk-bar-value { font-size: 11px; color: var(--wk-muted); font-variant-numeric: tabular-nums; }
  .wk-bar-track {
    height: 6px; border-radius: 4px; background: rgba(255,255,255,0.09); overflow: hidden;
  }
  .wk-bar-fill { height: 100%; border-radius: 4px; transition: width 0.4s ease; }
  /* Secondary rail: a second dimension on the same bar, e.g. time elapsed. */
  .wk-bar-track-sub {
    height: 3px; border-radius: 3px; background: rgba(255,255,255,0.06);
    overflow: hidden; margin-top: 5px;
  }
  .wk-bar-fill-sub { height: 100%; border-radius: 3px; background: #64748B; transition: width 0.4s ease; }
  .wk-bar-caption { font-size: 10px; color: #6B7280; margin-top: 4px; }

  /* A row that opens something on click. The negative margin lets the hover
     highlight bleed past the text without widening the row's own box. */
  .wk-click { cursor: pointer; border-radius: 8px; margin: 0 -8px; padding: 0 8px; }
  .wk-click:hover { background: rgba(255, 255, 255, 0.08); }

  .wk-message { padding: 6px 2px; font-size: 12px; color: var(--wk-muted); line-height: 1.5; }
  .wk-message code { color: #ECECEC; background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 4px; }
`;

// --------------------------------------------------------------- components

// The frosted panel every widget sits in. `live` drives the status dot;
// pass null to omit the dot entirely.
export function Card({ title, live, dotTitle, children }) {
  return (
    <div className="wk-card">
      {title != null && (
        <div className="wk-head">
          <span className="wk-title">{title}</span>
          {live != null && (
            <span
              className={"wk-dot " + (live ? "wk-live" : "wk-idle")}
              title={dotTitle || (live ? "Live" : "Idle")}
            />
          )}
        </div>
      )}
      {children}
    </div>
  );
}

export function Grid({ columns = 2, children }) {
  return (
    <div className="wk-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {children}
    </div>
  );
}

// One stat. `color` tints the value (cost amber, streak orange, …).
export function Tile({ value, label, color }) {
  return (
    <div className="wk-tile">
      <div className="v" style={color ? { color } : null}>{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export function Foot({ left, right }) {
  return (
    <div className="wk-foot">
      <span>{left}</span>
      <span className="accent">{right}</span>
    </div>
  );
}

// A titled block under a divider. `note` is the right-aligned annotation
// (staleness, count, …); `dim` renders the whole block as not-live.
export function Section({ title, note, noteTitle, dim, children }) {
  return (
    <div className={"wk-section" + (dim ? " wk-dim" : "")}>
      {(title || note) && (
        <div className="wk-section-title">
          <span>{title}</span>
          {note && <span className="wk-note" title={noteTitle}>{note}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

// A labelled progress bar with an optional second rail and caption.
//   percent    0–100, the main fill (null hides the track)
//   value      right-aligned text, e.g. "42% used"
//   subPercent 0–100, the thin rail underneath — a second dimension
//   caption    small text below, e.g. "Resets in 3h"
export function Bar({ label, percent, value, color, subPercent, subTitle, caption }) {
  return (
    <div className="wk-bar-row">
      <div className="wk-bar-head">
        <span className="wk-bar-label">{label}</span>
        {value != null && <span className="wk-bar-value">{value}</span>}
      </div>
      {percent != null && (
        <div className="wk-bar-track">
          <div
            className="wk-bar-fill"
            style={{ width: `${percent}%`, background: color || pctColor(percent) }}
          />
        </div>
      )}
      {subPercent != null && (
        <div className="wk-bar-track-sub" title={subTitle}>
          <div className="wk-bar-fill-sub" style={{ width: `${subPercent}%` }} />
        </div>
      )}
      {caption ? <div className="wk-bar-caption">{caption}</div> : null}
    </div>
  );
}

// Standard "helper isn't running" card, so every widget fails the same way.
export function Offline({ title, hint = "widget-helper serve" }) {
  return (
    <Card title={title} live={false} dotTitle="Helper offline">
      <div className="wk-message">
        Helper offline. Start it with:
        <br />
        <code>{hint}</code>
      </div>
    </Card>
  );
}

export function Message({ title, children }) {
  return (
    <Card title={title}>
      <div className="wk-message">{children}</div>
    </Card>
  );
}
