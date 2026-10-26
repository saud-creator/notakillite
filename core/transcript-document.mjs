import { randomUUID } from 'node:crypto';
export function newDocument(result, metadata = {}) {
  return { schemaVersion: 1, revision: 1, reviewStatus: 'unreviewed', metadata, quality: result.quality, duration: result.duration,
    segments: result.segments.map(s => ({ ...s, id: randomUUID(), rawText: s.text })), history: [] };
}
export function editDocument(doc, { revision, segmentId, text }) {
  if (revision !== doc.revision) throw new Error('Transcript changed. Reload before saving.');
  if (typeof text !== 'string' || text.length > 50000) throw new Error('Invalid segment text.');
  const segment = doc.segments.find(s => s.id === segmentId); if (!segment) throw new Error('Segment not found.');
  return { ...doc, revision: doc.revision + 1, reviewStatus: 'edited', segments: doc.segments.map(s => s.id === segmentId ? { ...s, text, manuallyEdited: true } : s),
    history: [...doc.history, { revision: doc.revision, segmentId, before: segment.text, after: text, at: new Date().toISOString() }] };
}
const timestamp = (seconds, comma = false) => { const ms = Math.round(Math.max(0, seconds) * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${comma ? ',' : '.'}${String(ms % 1000).padStart(3, '0')}`; };
export function exportDocument(doc, format) {
  if (format === 'json') return JSON.stringify(doc, null, 2);
  const segments = doc.segments.filter(s => !s.marker);
  if (format === 'txt') return `Review: ${doc.reviewStatus}; automatic audit: ${doc.quality.status}\n\n` + doc.segments.map(s => `[${timestamp(s.start)}] ${s.marker ? '⚠ ' : ''}${s.text}`).join('\n');
  if (format === 'md') return `# ${doc.metadata.title || 'Transcript'}\n\nReview: ${doc.reviewStatus}; automatic audit: ${doc.quality.status}\n\n` + doc.segments.map(s => `**[${timestamp(s.start)}]** ${s.marker ? '⚠ ' : ''}${s.text}`).join('\n\n');
  if (!['srt', 'vtt'].includes(format)) throw new Error('Unsupported export format.');
  return (format === 'vtt' ? 'WEBVTT\n\n' : '') + segments.map((s, i) => `${i + 1}\n${timestamp(s.start, format === 'srt')} --> ${timestamp(s.end, format === 'srt')}\n${s.text.replaceAll('-->', '→').replace(/\n\s*\n/g, '\n')}\n`).join('\n');
}
