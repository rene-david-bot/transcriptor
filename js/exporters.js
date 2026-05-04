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
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_500);
}

function formatSegmentForMarkdown(segment, timestamp) {
  return [
    `### ${timestamp}`,
    '',
    `**${segment.sourceLanguage.toUpperCase()}**`,
    '',
    segment.sourceText || '',
    '',
    `**${segment.targetLanguage.toUpperCase()}**`,
    '',
    segment.translatedText || '',
    '',
  ].join('\n');
}

function formatSegmentForText(segment, timestamp) {
  return [
    `[${timestamp}] ${segment.sourceLanguage.toUpperCase()}`,
    segment.sourceText || '',
    '',
    `[${timestamp}] ${segment.targetLanguage.toUpperCase()}`,
    segment.translatedText || '',
    '',
  ].join('\n');
}

export function exportSessionMarkdown(session, segments, formatTimestamp) {
  const base = buildExportBaseName(session);
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
    `Created: ${session.createdAt}`,
    `Status: ${session.status}`,
    `Source: ${session.sourceLanguage}`,
    `Target: ${session.targetLanguage}`,
    `Duration(ms): ${session.activeDurationMs || 0}`,
    `Segments: ${segments.length}`,
    session.glossary ? `Glossary: ${session.glossary}` : null,
    '',
    ...segments.flatMap((segment) => [formatSegmentForText(segment, formatTimestamp(segment)), '']),
  ]
    .filter(Boolean)
    .join('\n');

  download(content, `${base}.txt`, 'text/plain;charset=utf-8');
}

export function exportSessionJson(session, segments) {
  const base = buildExportBaseName(session);
  const payload = {
    session,
    segments,
    exportedAt: new Date().toISOString(),
  };
  download(JSON.stringify(payload, null, 2), `${base}.json`, 'application/json;charset=utf-8');
}
