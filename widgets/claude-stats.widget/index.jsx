// Claude Code + Codex usage limits — Übersicht desktop widget.
//
// Deploy with ./scripts/deploy.sh (copies this folder, and the shared kit it
// symlinks, into the Übersicht widgets directory). The helper must be running:
// `widget-helper serve`.

import {
  statsCommand,
  parseOutput,
  baseCss,
  relTime,
  Card,
  Section,
  Bar,
  Offline,
  Message,
} from "./kit.jsx";
import { TITLE, presentAgentWidget } from "./view.js";

export const command = statsCommand("claude-stats");

export const refreshFrequency = 10000; // 10s

export const className = `
  top: 40px;
  left: 40px;
  width: 320px;
  ${baseCss}
`;

// Length of each rate-limit window, so the time rail has a denominator.
// five_hour → 5h; every seven_day* window → 7 days.
function windowSeconds(bar) {
  if (bar.windowSeconds != null) return bar.windowSeconds;
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

const UsageSection = ({ name, limits }) => (
  <Section
    title={`${name} usage${limits.plan ? ` · ${limits.plan}` : ""}`}
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
);

export const render = ({ output }) => {
  const { offline, error, data: s } = parseOutput(output);
  if (offline) return <Offline title={TITLE} />;
  if (error) return <Message title={TITLE}>{error}</Message>;

  const view = presentAgentWidget(s);

  return (
    <Card title={view.title} live={view.live} dotTitle={view.dotTitle}>
      {view.sections.map((section) => <UsageSection key={section.name} {...section} />)}
      {view.sections.length === 0 && <div className="wk-message">Usage unavailable.</div>}
    </Card>
  );
};
