// System Status — Übersicht desktop widget.
//
// Reads GET /stats/system-status from the local helper (src/providers/system-status/).
// Deploy with ./scripts/deploy.sh (copies this folder, and the shared kit it
// symlinks, into the Übersicht widgets directory).

import {
  statsCommand,
  parseOutput,
  baseCss,
  relTime,
  openApp,
  Card,
  Grid,
  Tile,
  Foot,
  Section,
  Bar,
  Offline,
  Message,
} from "./kit.jsx";

const TITLE = "System Status";

export const command = statsCommand("system-status");

export const refreshFrequency = 10000; // 10s

// Bottom-anchored in the same column as claude-stats: that widget's height
// changes with how many plan-limit bars it has, so anchoring this one to the
// top would leave a gap or an overlap depending on the day.
export const className = `
  left: 40px;
  bottom: 40px;
  width: 320px;
  ${baseCss}
`;

// null is not "offline": until the first probe lands we do not know, and
// guessing either way would be wrong on screen for the first few seconds of
// every login. The colours are the kit's tokens, resolved from baseCss.
const NET = {
  null: { label: "—", color: "var(--wk-muted)", title: "Checking connectivity" },
  true: { label: "Online", color: "var(--wk-ok)", title: "Online" },
  false: { label: "Offline", color: "var(--wk-bad)", title: "No internet connection" },
};

// Memory and Disk differ only in their label, so the "unavailable" fallback
// cannot drift between the two rows.
const UsageBar = ({ label, reading: r }) => (
  <Bar
    label={label}
    percent={r ? r.usedPercent : null}
    value={r ? `${Math.round(r.usedPercent)}%` : "—"}
    caption={r ? r.text : "unavailable"}
  />
);

export const render = ({ output }) => {
  const { offline, error, data } = parseOutput(output);
  if (offline) return <Offline title={TITLE} />;
  if (error) return <Message title={TITLE}>{error}</Message>;

  const internet = data.internet || {};
  const net = NET[String(internet.online)] || NET.null;
  // The verdict is re-probed every 30s (longer during a retry ladder) while the
  // widget refreshes every 10s, so the footer's "updated just now" does not
  // speak for this tile. Hovering the dot says when it was actually measured.
  const dotTitle = internet.checkedAt ? `${net.title} · ${relTime(internet.checkedAt)}` : net.title;

  return (
    <Card
      title={TITLE}
      live={internet.online === true}
      dotTitle={dotTitle}
      onClick={() => openApp("Activity Monitor")}
      clickTitle="Open Activity Monitor"
    >
      <Grid columns={2}>
        <Tile value={data.uptime?.text || "—"} label="Uptime" />
        <Tile value={net.label} label="Internet" color={net.color} />
      </Grid>

      <Section>
        <UsageBar label="Memory" reading={data.memory} />
        <UsageBar label="Disk" reading={data.disk} />
      </Section>

      <Foot left={relTime(data.generatedAt, "updated")} right="system-status" />
    </Card>
  );
};
