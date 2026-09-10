'use strict';

const TITLE = 'Agent Widget';

function presentAgentWidget(data) {
  const sections = [
    { name: 'Claude', limits: data && data.planLimits },
    { name: 'Codex', limits: data && data.codexLimits },
  ].filter((section) => section.limits && section.limits.bars && section.limits.bars.length > 0);
  const live = sections.length ? sections.some((section) => section.limits.available && !section.limits.stale) : null;
  return {
    title: TITLE,
    live,
    dotTitle: live ? 'Usage available' : sections.length ? 'Showing stale usage' : null,
    sections,
  };
}

module.exports = { TITLE, presentAgentWidget };
