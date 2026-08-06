// Claude Code statistics — Übersicht desktop widget.
//
// Deploy with ./scripts/deploy.sh (copies this folder, and the shared kit it
// symlinks, into the Übersicht widgets directory). The helper must be running:
// `widget-helper serve`.

import {
  statsCommand,
  parseOutput,
  baseCss,
  fmt,
  hour,
  relTime,
  Card,
  Grid,
  Tile,
  Foot,
  Section,
  Bar,
  Offline,
  Message,
} from "./kit.jsx";

const TITLE = "Claude Code";

export const command = statsCommand("claude-stats");

export const refreshFrequency = 10000; // 10s

export const className = `
  top: 40px;
  left: 40px;
  width: 320px;
  ${baseCss}

  /* Six tiles in a 3x2 grid: the kit's default tile is sized for two columns,
     so shrink it here rather than in the kit (linear/system-status still want
     the roomier default). */
  .wk-grid { gap: 8px; }
  .wk-tile { padding: 7px 8px; border-radius: 10px; }
  .wk-tile .v { font-size: 16px; }
  .wk-tile .l { font-size: 9px; letter-spacing: 0.4px; margin-top: 2px; }
`;

// Whole dollars — cents are noise on a lifetime estimate, and the narrower
// string fits the 3-column tile. (The kit's usd() keeps them for widgets
// where the cents mean something.)
function usdWhole(n) {
  if (n == null) return "—";
  return "$" + Math.round(Number(n)).toLocaleString("en-US");
}

function shortModel(m) {
  if (!m) return "—";
  return m.replace(/^anthropic\./, "").replace(/-\d{8}$/, "");
}

// Length of each rate-limit window, so the time rail has a denominator.
// five_hour → 5h; every seven_day* window → 7 days.
function windowSeconds(bar) {
  if (bar.id === "five_hour") return 5 * 3600;
  if (bar.id && bar.id.indexOf("seven_day") === 0) return 7 * 86400;
  return null;
}

// Fraction of the window already elapsed (0–100), from resetInSeconds.
function timeElapsedPercent(bar) {
  const total = windowSeconds(bar);
  if (total == null || bar.resetInSeconds == null) return null;
  const remaining = Math.max(0, Math.min(total, bar.resetInSeconds));
  return ((total - remaining) / total) * 100;
}

function resetText(bar) {
  const s = bar.resetInSeconds;
  if (s != null && s < 86400) {
    if (s < 3600) return `Resets in ${Math.max(1, Math.round(s / 60))} min`;
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return `Resets in ${h}h${m ? " " + m + "m" : ""}`;
  }
  if (bar.resetAt) {
    const d = new Date(bar.resetAt);
    if (!isNaN(d.getTime())) {
      const day = d.toLocaleDateString("en-US", { weekday: "short" });
      const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      return `Resets ${day} ${time}`;
    }
  }
  return "";
}

export const render = ({ output }) => {
  const { offline, error, data: s } = parseOutput(output);
  if (offline) return <Offline title={TITLE} />;
  if (error) return <Message title={TITLE}>{error}</Message>;

  const live = s.telemetry && s.telemetry.available;
  const t = s.tokens || {};
  const limits = s.planLimits;

  return (
    <Card title={TITLE} live={live} dotTitle={live ? "Live telemetry" : "Files only"}>
      <Grid columns={3}>
        <Tile value={fmt(s.sessions)} label="Sessions" />
        <Tile value={fmt(s.messages)} label="Messages" />
        <Tile value={fmt(t.total)} label="Tokens" />
        <Tile value={usdWhole(s.cost)} label="Est. Cost" color="#FBBF24" />
        <Tile value={`${fmt(s.currentStreak)}🔥`} label="Day Streak" color="#F97316" />
        <Tile value={hour(s.peakHour)} label="Peak Hour" />
      </Grid>

      <Foot left={`${fmt(s.activeDays)} active days`} right={shortModel(s.favoriteModel)} />

      {limits?.bars?.length > 0 && (
        <Section
          title={`Plan usage limits${limits.plan ? ` · ${limits.plan}` : ""}`}
          note={limits.stale ? relTime(limits.staleSince) : null}
          noteTitle={limits.error || "refresh failed"}
          dim={limits.stale}
        >
          {limits.bars.map((bar) => (
            <Bar
              key={bar.id}
              label={bar.label}
              percent={bar.usedPercent}
              value={bar.usedPercent != null ? `${bar.usedPercent}% used` : null}
              subPercent={timeElapsedPercent(bar)}
              subTitle="Time elapsed in this window"
              caption={resetText(bar)}
            />
          ))}
        </Section>
      )}
    </Card>
  );
};
