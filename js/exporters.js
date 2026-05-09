function safeFilePart(value) {
  return String(value || 'session')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'session';
}

export function buildExportBaseName(session) {
  const stamp = (session.createdAt || new Date().toISOString()).replace(/[:.]/g, '-');
  return `${safeFilePart(session.title || 'session')}-${stamp}`;
}

function download(content, filename, mimeType) {
  const withBom = typeof content === 'string' && String(mimeType || '').startsWith('text/plain') ? `\uFEFF${content}` : content;
  const blob = new Blob([withBom], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_500);
}

function formatDuration(ms = 0) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function buildSpeakerSummary(segments) {
  const summaryMap = new Map();

  for (const segment of segments) {
    if (!segment.speakerLabel) continue;
    const current = summaryMap.get(segment.speakerLabel) || {
      label: segment.speakerLabel,
      durationMs: 0,
      segments: 0,
    };
    current.durationMs += Math.max(1000, segment.speakerDurationMs || segment.endMs - segment.startMs || 0);
    current.segments += 1;
    summaryMap.set(segment.speakerLabel, current);
  }

  return Array.from(summaryMap.values()).sort((a, b) => b.durationMs - a.durationMs || a.label.localeCompare(b.label));
}

function buildSpeakerSummaryLines(summary, prefix = '- ') {
  if (!summary.length) return [];

  const totalDurationMs = summary.reduce((total, speaker) => total + speaker.durationMs, 0);
  return [
    `${prefix}Total speaker time: ${formatDuration(totalDurationMs)}`,
    ...summary.map(
      (speaker) => `${prefix}${speaker.label}: ${formatDuration(speaker.durationMs)} (${speaker.segments} segment${speaker.segments === 1 ? '' : 's'})`
    ),
  ];
}

function formatSegmentForMarkdown(segment, timestamp) {
  const speakerLine = segment.speakerLabel
    ? `- Speaker: ${segment.speakerLabel}`
    : segment.speakerStatus === 'pending'
      ? '- Speaker: analyzing'
      : null;

  return [
    `### ${timestamp}`,
    '',
    speakerLine,
    speakerLine ? '' : null,
    `**${segment.sourceLanguage.toUpperCase()}**`,
    '',
    segment.sourceText || '',
    '',
    `**${segment.targetLanguage.toUpperCase()}**`,
    '',
    segment.translatedText || '',
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

function formatSegmentForText(segment, timestamp) {
  const speakerLabel = segment.speakerLabel || (segment.speakerStatus === 'pending' ? 'analyzing' : '');
  const sourceHeader = [`[${timestamp}]`, speakerLabel, segment.sourceLanguage.toUpperCase()].filter(Boolean).join(' ');
  const targetHeader = segment.targetLanguage.toUpperCase();

  return [sourceHeader, segment.sourceText || '', targetHeader, segment.translatedText || ''].join('\n');
}

export function exportSessionMarkdown(session, segments, formatTimestamp) {
  const base = buildExportBaseName(session);
  const speakerSummary = buildSpeakerSummary(segments);
  const content = [
    `# ${session.title}`,
    '',
    `- Created: ${session.createdAt}`,
    `- Status: ${session.status}`,
    `- Source language: ${session.sourceLanguage}`,
    `- Target language: ${session.targetLanguage}`,
    `- Active duration ms: ${session.activeDurationMs || 0}`,
    `- Segment count: ${segments.length}`,
    session.glossary ? `- Glossary: ${session.glossary}` : null,
    ...buildSpeakerSummaryLines(speakerSummary),
    '',
    '---',
    '',
    ...segments.flatMap((segment) => [formatSegmentForMarkdown(segment, formatTimestamp(segment)), '']),
  ]
    .filter(Boolean)
    .join('\n');

  download(content, `${base}.md`, 'text/markdown;charset=utf-8');
}

export function exportSessionTxt(session, segments, formatTimestamp) {
  const base = buildExportBaseName(session);
  const content = [
    `${session.title}`,
    '',
    ...segments.flatMap((segment, index) => [formatSegmentForText(segment, formatTimestamp(segment)), index < segments.length - 1 ? '' : null]),
  ]
    .filter((line) => line !== null)
    .join('\n');

  download(content, `${base}.txt`, 'text/plain;charset=utf-8');
}

export function exportSessionJson(session, segments) {
  const base = buildExportBaseName(session);
  const speakerSummary = buildSpeakerSummary(segments);
  const payload = {
    session,
    segments,
    speakerSummary,
    speakerTotalDurationMs: speakerSummary.reduce((total, speaker) => total + speaker.durationMs, 0),
    exportedAt: new Date().toISOString(),
  };
  download(JSON.stringify(payload, null, 2), `${base}.json`, 'application/json;charset=utf-8');
}
