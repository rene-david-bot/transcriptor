import {
  clearAllSessions,
  countSegments,
  deleteMeta,
  deleteSession,
  deleteEndedSessions,
  getMeta,
  getSession,
  getSettings,
  getStorageSummary,
  listSegmentsBySession,
  listSessions,
  saveSettings,
  setMeta,
  upsertSegment,
  upsertSession,
} from './db.js';
import { exportSessionJson, exportSessionMarkdown, exportSessionTxt } from './exporters.js';
import { diarizeAudioChunk, RealtimeTranscriptionClient, translateText } from './openai.js';

const LANGUAGES = [
  ['ar', 'Arabic'],
  ['bg', 'Bulgarian'],
  ['zh', 'Chinese'],
  ['hr', 'Croatian'],
  ['cs', 'Czech'],
  ['da', 'Danish'],
  ['nl', 'Dutch'],
  ['en', 'English'],
  ['et', 'Estonian'],
  ['fi', 'Finnish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['el', 'Greek'],
  ['he', 'Hebrew'],
  ['hi', 'Hindi'],
  ['hu', 'Hungarian'],
  ['id', 'Indonesian'],
  ['it', 'Italian'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['lv', 'Latvian'],
  ['lt', 'Lithuanian'],
  ['ms', 'Malay'],
  ['no', 'Norwegian'],
  ['fa', 'Persian'],
  ['pl', 'Polish'],
  ['pt', 'Portuguese'],
  ['ro', 'Romanian'],
  ['ru', 'Russian'],
  ['sr', 'Serbian'],
  ['sk', 'Slovak'],
  ['sl', 'Slovenian'],
  ['es', 'Spanish'],
  ['sv', 'Swedish'],
  ['th', 'Thai'],
  ['tr', 'Turkish'],
  ['uk', 'Ukrainian'],
  ['ur', 'Urdu'],
  ['vi', 'Vietnamese'],
];

const LANGUAGE_MAP = new Map(LANGUAGES);
const DEFAULT_SETTINGS = {
  apiKey: '',
  sourceLanguage: 'it',
  targetLanguage: 'en',
  glossary: '',
  speakerNames: '',
  autoScroll: true,
  textSize: 'medium',
  timestampStyle: 'elapsed',
};

const STATUS_COPY = {
  idle: 'idle',
  connecting: 'connecting',
  listening: 'listening',
  paused: 'paused',
  reconnecting: 'reconnecting',
  stopped: 'stopped',
  ended: 'ended',
  error: 'error',
};

const DRAFT_TRANSLATION_MIN_CHARS = 4;
const DRAFT_TRANSLATION_INTERVAL_MS = 450;
const DRAFT_TRANSLATION_ABORT_GROWTH_CHARS = 18;
const LIVE_COMMIT_WARMUP_MS = 2200;
const LIVE_COMMIT_INTERVAL_MS = 3800;
const LIVE_COMMIT_RETRY_MS = 650;
const LIVE_COMMIT_MIN_CHARS = 48;
const LIVE_COMMIT_MIN_WORDS = 8;
const LIVE_COMMIT_SENTENCE_MIN_CHARS = 24;
const LIVE_COMMIT_SENTENCE_MIN_WORDS = 5;
const LIVE_COMMIT_MAX_HOLD_MS = 6500;
const LIVE_COMMIT_FALLBACK_MIN_CHARS = 18;
const LIVE_COMMIT_FALLBACK_MIN_WORDS = 4;
const SPEAKER_CHUNK_MS = 20000;
const SPEAKER_MIN_CHUNK_BYTES = 4000;
const SPEAKER_MATCH_MARGIN_MS = 3200;

const state = {
  route: 'setup',
  settings: { ...DEFAULT_SETTINGS },
  sessions: [],
  currentSession: null,
  currentSegments: [],
  client: null,
  runtimeStatus: 'idle',
  runtimeMessage: 'Waiting to start.',
  listenStartedAtMs: null,
  speechStartedAtMs: null,
  speechActive: false,
  draftByItemId: new Map(),
  commitMetaByItemId: new Map(),
  draftTranslationTimer: null,
  draftTranslationPending: null,
  draftTranslationInFlight: false,
  draftTranslationActive: null,
  draftTranslationAbortController: null,
  draftTranslationLastStartedAt: 0,
  finalTranslationQueue: Promise.resolve(),
  finalTranslationInFlight: false,
  liveCommitTimer: null,
  liveCommitInFlight: false,
  lastLiveCommitAtMs: 0,
  liveDraftCarryItemId: null,
  liveDraftCarrySource: '',
  liveDraftCarryTranslation: '',
  speakerTrackingSupported: typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined',
  speakerRecorder: null,
  speakerStream: null,
  speakerMimeType: '',
  speakerChunkStartMs: 0,
  speakerChunkIndex: 0,
  speakerAttributionQueue: Promise.resolve(),
  speakerTrackingInFlight: false,
  speakerTrackingPendingChunks: 0,
  speakerTrackingSessionId: null,
  speakerTrackingStatus: 'Speaker detection is idle.',
  sessionPersistTimer: null,
  clockTimer: null,
  installPrompt: null,
  activeDraftItemId: null,
  liveTranscriptView: 'both',
  transcriptPinnedToBottom: true,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const elements = {
  sidebar: $('#sidebar'),
  backdrop: $('#backdrop'),
  menuButton: $('#menuButton'),
  sidebarClose: $('#sidebarClose'),
  statusPill: $('#statusPill'),
  statusLine: $('#statusLine'),
  topbarEyebrow: $('#topbarEyebrow'),
  toast: $('#toast'),
  startForm: $('#startForm'),
  apiKeyInput: $('#apiKeyInput'),
  toggleApiKey: $('#toggleApiKey'),
  sourceLanguageInput: $('#sourceLanguageInput'),
  targetLanguageInput: $('#targetLanguageInput'),
  glossaryInput: $('#glossaryInput'),
  speakerNamesInput: $('#speakerNamesInput'),
  resumeLastSessionButton: $('#resumeLastSessionButton'),
  recoverDraftButton: $('#recoverDraftButton'),
  openHistoryFromSetup: $('#openHistoryFromSetup'),
  sessionTitle: $('#sessionTitle'),
  sessionMeta: $('#sessionMeta'),
  durationValue: $('#durationValue'),
  speechOnlyValue: $('#speechOnlyValue'),
  segmentCountValue: $('#segmentCountValue'),
  startButton: $('#startButton'),
  pauseButton: $('#pauseButton'),
  resumeButton: $('#resumeButton'),
  stopButton: $('#stopButton'),
  newSessionButton: $('#newSessionButton'),
  endSessionButton: $('#endSessionButton'),
  transcriptBoard: $('#transcriptBoard'),
  transcriptSourceHeading: $('#transcriptSourceHeading'),
  transcriptTargetHeading: $('#transcriptTargetHeading'),
  transcriptLiveState: $('#transcriptLiveState'),
  jumpToLiveButton: $('#jumpToLiveButton'),
  sourceDraftLabel: $('#sourceDraftLabel'),
  sourceDraftText: $('#sourceDraftText'),
  sourceDraftState: $('#sourceDraftState'),
  sourceDraftCarry: $('#sourceDraftCarry'),
  sourceDraftCarryText: $('#sourceDraftCarryText'),
  targetDraftLabel: $('#targetDraftLabel'),
  targetDraftText: $('#targetDraftText'),
  targetDraftState: $('#targetDraftState'),
  targetDraftCarry: $('#targetDraftCarry'),
  targetDraftCarryText: $('#targetDraftCarryText'),
  speakerStatusLine: $('#speakerStatusLine'),
  speakerSummary: $('#speakerSummary'),
  transcriptList: $('#transcriptList'),
  exportMarkdownButton: $('#exportMarkdownButton'),
  exportTxtButton: $('#exportTxtButton'),
  exportJsonButton: $('#exportJsonButton'),
  exportCurrentFromSide: $('#exportCurrentFromSide'),
  historyList: $('#historyList'),
  refreshHistoryButton: $('#refreshHistoryButton'),
  settingsForm: $('#settingsForm'),
  settingsApiKeyInput: $('#settingsApiKeyInput'),
  settingsToggleApiKey: $('#settingsToggleApiKey'),
  settingsSourceLanguage: $('#settingsSourceLanguage'),
  settingsTargetLanguage: $('#settingsTargetLanguage'),
  textSizeSelect: $('#textSizeSelect'),
  autoScrollInput: $('#autoScrollInput'),
  timestampStyleSelect: $('#timestampStyleSelect'),
  settingsGlossaryInput: $('#settingsGlossaryInput'),
  settingsSpeakerNamesInput: $('#settingsSpeakerNamesInput'),
  forgetApiKeyButton: $('#forgetApiKeyButton'),
  clearEndedSessionsButton: $('#clearEndedSessionsButton'),
  clearAllSessionsButton: $('#clearAllSessionsButton'),
  clearDraftsButton: $('#clearDraftsButton'),
  storageStats: $('#storageStats'),
  installCard: $('#installCard'),
  installButton: $('#installButton'),
  toggleAutoScrollButton: $('#toggleAutoScrollButton'),
  renameSessionButton: $('#renameSessionButton'),
};

const TRANSCRIPT_VIEW_MODES = new Set(['source', 'both', 'target']);

function nowIso() {
  return new Date().toISOString();
}

function getLanguageName(code) {
  return LANGUAGE_MAP.get(code) || String(code || '').toUpperCase();
}

function slugDate(dateString) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(dateString));
}

function pad(num) {
  return String(num).padStart(2, '0');
}

function formatDuration(ms = 0) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

function formatShortTime(isoString) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(isoString));
}

function buildSessionTitle(createdAt, sourceLanguage, targetLanguage) {
  const languagePart = `${getLanguageName(sourceLanguage)} → ${getLanguageName(targetLanguage)}`;
  return `${languagePart} • ${slugDate(createdAt)}`;
}

function normalizeTranscript(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, ' ')
    .replace(/[“”"'`´]/g, '')
    .replace(/[.,!?;:]+$/g, '');
}

function buildSessionMeta(session) {
  if (!session) return 'Start a session to begin.';
  const parts = [
    `${getLanguageName(session.sourceLanguage)} → ${getLanguageName(session.targetLanguage)}`,
    slugDate(session.createdAt),
    `${session.segmentCount || 0} segment${(session.segmentCount || 0) === 1 ? '' : 's'}`,
  ];
  if (session.status === 'ended' && session.endedAt) {
    parts.push(`Ended ${slugDate(session.endedAt)}`);
  }
  return parts.join(' • ');
}

function showToast(message, timeout = 3200) {
  elements.toast.textContent = message;
  elements.toast.classList.add('toast--visible');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    elements.toast.classList.remove('toast--visible');
  }, timeout);
}

function setStatus(status, message) {
  state.runtimeStatus = status;
  state.runtimeMessage = message;
  elements.statusPill.textContent = STATUS_COPY[status] || status;
  elements.statusPill.className = `status-pill status-pill--${status}`;
  elements.statusLine.textContent = `Status: ${message}`;
  elements.topbarEyebrow.textContent = status === 'listening' ? 'Live capture' : 'Transcripto';

  if (state.currentSession) {
    state.currentSession.runtimeStatus = status;
    if (status === 'listening' || status === 'connecting' || status === 'reconnecting') {
      state.currentSession.status = 'active';
    } else if (status === 'paused' || status === 'stopped' || status === 'error') {
      state.currentSession.status = state.currentSession.status === 'ended' ? 'ended' : 'paused';
    } else if (status === 'ended') {
      state.currentSession.status = 'ended';
    }
    state.currentSession.updatedAt = nowIso();
    scheduleSessionPersist();
  }

  renderControls();
}

function fillLanguageSelect(select) {
  select.innerHTML = LANGUAGES.map(
    ([code, label]) => `<option value="${code}">${label}</option>`
  ).join('');
}

function applySettingsToForms() {
  const settings = state.settings;
  elements.apiKeyInput.value = settings.apiKey || '';
  elements.settingsApiKeyInput.value = settings.apiKey || '';
  elements.sourceLanguageInput.value = settings.sourceLanguage;
  elements.targetLanguageInput.value = settings.targetLanguage;
  elements.settingsSourceLanguage.value = settings.sourceLanguage;
  elements.settingsTargetLanguage.value = settings.targetLanguage;
  elements.glossaryInput.value = settings.glossary || '';
  elements.speakerNamesInput.value = settings.speakerNames || '';
  elements.settingsGlossaryInput.value = settings.glossary || '';
  elements.settingsSpeakerNamesInput.value = settings.speakerNames || '';
  elements.textSizeSelect.value = settings.textSize || 'medium';
  elements.autoScrollInput.checked = Boolean(settings.autoScroll);
  elements.timestampStyleSelect.value = settings.timestampStyle || 'elapsed';
  elements.toggleAutoScrollButton.textContent = `Auto-scroll: ${settings.autoScroll ? 'On' : 'Off'}`;
  document.body.classList.remove('text-size-small', 'text-size-medium', 'text-size-large', 'text-size-xlarge');
  document.body.classList.add(`text-size-${settings.textSize || 'medium'}`);
  elements.transcriptList.classList.remove('text-size-small', 'text-size-medium', 'text-size-large', 'text-size-xlarge');
  elements.transcriptList.classList.add(`text-size-${settings.textSize || 'medium'}`);
  if (elements.transcriptSourceHeading) {
    elements.transcriptSourceHeading.textContent = getLanguageName(state.currentSession?.sourceLanguage || settings.sourceLanguage || '');
  }
  if (elements.transcriptTargetHeading) {
    elements.transcriptTargetHeading.textContent = getLanguageName(state.currentSession?.targetLanguage || settings.targetLanguage || '');
  }
  applyTranscriptView();
}

function getTranscriptViewButtons() {
  return $$('[data-transcript-view]');
}

function applyTranscriptView() {
  if (!elements.transcriptBoard) return;
  const mode = TRANSCRIPT_VIEW_MODES.has(state.liveTranscriptView) ? state.liveTranscriptView : 'both';
  elements.transcriptBoard.classList.remove('transcript-board--source', 'transcript-board--both', 'transcript-board--target');
  elements.transcriptBoard.classList.add(`transcript-board--${mode}`);
  getTranscriptViewButtons().forEach((button) => {
    const active = button.dataset.transcriptView === mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function setTranscriptView(mode) {
  state.liveTranscriptView = TRANSCRIPT_VIEW_MODES.has(mode) ? mode : 'both';
  applyTranscriptView();
}

function isTranscriptNearBottom(threshold = 96) {
  const list = elements.transcriptList;
  if (!list) return true;
  return list.scrollHeight - list.scrollTop - list.clientHeight <= threshold;
}

function updateTranscriptAutoFollowState() {
  state.transcriptPinnedToBottom = isTranscriptNearBottom();
  if (elements.jumpToLiveButton) {
    elements.jumpToLiveButton.classList.toggle('hidden', state.transcriptPinnedToBottom || !state.currentSession);
  }
}

function scrollTranscriptToLive(behavior = 'smooth') {
  const list = elements.transcriptList;
  if (!list) return;
  const jumpToBottom = () => {
    if (behavior === 'smooth') {
      list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    } else {
      list.scrollTop = list.scrollHeight;
    }
  };
  jumpToBottom();
  requestAnimationFrame(() => {
    jumpToBottom();
    state.transcriptPinnedToBottom = true;
    updateTranscriptAutoFollowState();
  });
}

async function persistSettings(partial = {}) {
  state.settings = {
    ...state.settings,
    ...partial,
  };
  await saveSettings(state.settings);
  applySettingsToForms();
}

function scheduleSessionPersist(delay = 250) {
  if (!state.currentSession) return;
  window.clearTimeout(state.sessionPersistTimer);
  state.sessionPersistTimer = window.setTimeout(async () => {
    if (!state.currentSession) return;
    state.currentSession.updatedAt = nowIso();
    await upsertSession({ ...state.currentSession });
  }, delay);
}

async function persistCurrentSessionNow() {
  if (!state.currentSession) return;
  window.clearTimeout(state.sessionPersistTimer);
  state.currentSession.updatedAt = nowIso();
  await upsertSession({ ...state.currentSession });
}

function markListeningStart() {
  if (!state.listenStartedAtMs) {
    state.listenStartedAtMs = Date.now();
  }
}

function flushListeningClock() {
  if (state.currentSession && state.listenStartedAtMs) {
    state.currentSession.activeDurationMs = (state.currentSession.activeDurationMs || 0) + (Date.now() - state.listenStartedAtMs);
    state.listenStartedAtMs = null;
  }
}

function markSpeechStart() {
  if (!state.speechStartedAtMs) {
    state.speechStartedAtMs = Date.now();
  }
}

function flushSpeechClock() {
  if (state.currentSession && state.speechStartedAtMs) {
    state.currentSession.speechOnlyMs = (state.currentSession.speechOnlyMs || 0) + (Date.now() - state.speechStartedAtMs);
    state.speechStartedAtMs = null;
  }
}

function clearLiveCommitTimer() {
  window.clearTimeout(state.liveCommitTimer);
  state.liveCommitTimer = null;
}

function resetLiveCommitState() {
  clearLiveCommitTimer();
  state.liveCommitInFlight = false;
  state.lastLiveCommitAtMs = 0;
}

function clearLiveDraftCarry() {
  state.liveDraftCarryItemId = null;
  state.liveDraftCarrySource = '';
  state.liveDraftCarryTranslation = '';
}

function setLiveDraftCarry({ itemId = null, source = '', translation = '' } = {}) {
  state.liveDraftCarryItemId = itemId || null;
  state.liveDraftCarrySource = String(source || '').trim();
  state.liveDraftCarryTranslation = String(translation || '').trim();
}

function captureVisibleDraftCarry(previousItemId = state.activeDraftItemId) {
  const previousDraft = previousItemId ? state.draftByItemId.get(previousItemId) : null;
  const lastSegment = state.currentSegments[state.currentSegments.length - 1];
  const source = previousDraft?.sourceDraft?.trim() || state.currentSession?.draftSource?.trim() || '';
  const lastSegmentMatchesPrevious = Boolean(
    source &&
      lastSegment?.sourceText &&
      (lastSegment.itemId === previousItemId || normalizeTranscript(lastSegment.sourceText) === normalizeTranscript(source))
  );
  const translation =
    previousDraft?.translatedDraft?.trim() ||
    state.currentSession?.draftTranslation?.trim() ||
    (lastSegmentMatchesPrevious ? String(lastSegment?.translatedText || lastSegment?.translatedDraft || '').trim() : '');

  if (!source && !translation) {
    clearLiveDraftCarry();
    return;
  }

  setLiveDraftCarry({ itemId: previousItemId || lastSegment?.itemId || null, source, translation });
}

function getLiveCommitDraftText() {
  const activeDraft = state.activeDraftItemId ? state.draftByItemId.get(state.activeDraftItemId)?.sourceDraft : '';
  return String(activeDraft || state.currentSession?.draftSource || '').trim();
}

function countDraftWords(text) {
  return normalizeTranscript(text)
    .split(' ')
    .filter(Boolean).length;
}

function shouldCommitLiveDraftText(text = '', sinceLastCommitMs = 0) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;

  const chars = trimmed.length;
  const words = countDraftWords(trimmed);
  const sentenceLike = /[.!?…:;]\s*$/.test(trimmed);

  if (sentenceLike && (chars >= LIVE_COMMIT_SENTENCE_MIN_CHARS || words >= LIVE_COMMIT_SENTENCE_MIN_WORDS)) {
    return true;
  }

  if (chars >= LIVE_COMMIT_MIN_CHARS || words >= LIVE_COMMIT_MIN_WORDS) {
    return true;
  }

  return Boolean(
    sinceLastCommitMs >= LIVE_COMMIT_MAX_HOLD_MS &&
      (chars >= LIVE_COMMIT_FALLBACK_MIN_CHARS || words >= LIVE_COMMIT_FALLBACK_MIN_WORDS)
  );
}

function canSendLiveCommit(text = getLiveCommitDraftText()) {
  const sinceLastCommitMs = state.lastLiveCommitAtMs
    ? Date.now() - state.lastLiveCommitAtMs
    : state.speechStartedAtMs
      ? Date.now() - state.speechStartedAtMs
      : 0;
  return shouldCommitLiveDraftText(text, sinceLastCommitMs);
}

function requestLiveCommit() {
  clearLiveCommitTimer();
  if (!state.client || !state.speechActive || state.liveCommitInFlight) return;

  if (!canSendLiveCommit()) {
    if (state.client && state.speechActive) {
      state.liveCommitTimer = window.setTimeout(() => {
        requestLiveCommit();
      }, LIVE_COMMIT_RETRY_MS);
    }
    return;
  }

  state.liveCommitInFlight = true;
  const sent = state.client.commitInputAudioBuffer?.();
  if (sent) {
    return;
  }

  state.liveCommitInFlight = false;
  state.liveCommitTimer = window.setTimeout(() => {
    requestLiveCommit();
  }, LIVE_COMMIT_RETRY_MS);
}

function scheduleLiveCommit() {
  if (state.liveCommitInFlight) return;
  clearLiveCommitTimer();
  if (!state.client || !state.currentSession || !state.speechActive || state.currentSession.status === 'ended') {
    return;
  }

  const now = Date.now();
  const warmupRemaining = Math.max(0, LIVE_COMMIT_WARMUP_MS - (state.speechStartedAtMs ? now - state.speechStartedAtMs : 0));
  const intervalRemaining = Math.max(
    0,
    LIVE_COMMIT_INTERVAL_MS - (state.lastLiveCommitAtMs ? now - state.lastLiveCommitAtMs : LIVE_COMMIT_INTERVAL_MS)
  );
  const delay = Math.max(warmupRemaining, intervalRemaining);

  state.liveCommitTimer = window.setTimeout(() => {
    requestLiveCommit();
  }, delay);
}

function getEffectiveActiveDuration() {
  const base = state.currentSession?.activeDurationMs || 0;
  return state.listenStartedAtMs ? base + (Date.now() - state.listenStartedAtMs) : base;
}

function getEffectiveSpeechDuration() {
  const base = state.currentSession?.speechOnlyMs || 0;
  return state.speechStartedAtMs ? base + (Date.now() - state.speechStartedAtMs) : base;
}

function startClockTimer() {
  window.clearInterval(state.clockTimer);
  state.clockTimer = window.setInterval(() => {
    renderSessionSummary();
  }, 1000);
}

function closeSidebar() {
  elements.sidebar.classList.remove('sidebar--open');
  elements.backdrop.classList.remove('backdrop--visible');
}

function openSidebar() {
  elements.sidebar.classList.add('sidebar--open');
  elements.backdrop.classList.add('backdrop--visible');
}

function setRoute(route) {
  state.route = route;
  $$('.page').forEach((page) => {
    page.classList.toggle('page--active', page.dataset.page === route);
  });
  closeSidebar();
}

function collectSettingsFromSetupForm() {
  return {
    apiKey: elements.apiKeyInput.value.trim(),
    sourceLanguage: elements.sourceLanguageInput.value,
    targetLanguage: elements.targetLanguageInput.value,
    glossary: elements.glossaryInput.value.trim(),
    speakerNames: normalizeSpeakerNamesInput(elements.speakerNamesInput.value),
  };
}

function collectSettingsFromSettingsForm() {
  return {
    apiKey: elements.settingsApiKeyInput.value.trim(),
    sourceLanguage: elements.settingsSourceLanguage.value,
    targetLanguage: elements.settingsTargetLanguage.value,
    glossary: elements.settingsGlossaryInput.value.trim(),
    speakerNames: normalizeSpeakerNamesInput(elements.settingsSpeakerNamesInput.value),
    textSize: elements.textSizeSelect.value,
    autoScroll: elements.autoScrollInput.checked,
    timestampStyle: elements.timestampStyleSelect.value,
  };
}

async function refreshSessions() {
  state.sessions = await listSessions();
  renderHistory();
  renderResumeButtons();
  renderStorageStats();
}

async function renderStorageStats() {
  const summary = await getStorageSummary();
  elements.storageStats.innerHTML = [
    `<div><strong>${summary.sessions}</strong> session${summary.sessions === 1 ? '' : 's'} stored locally</div>`,
    `<div><strong>${summary.activeSessions}</strong> active or resumable session${summary.activeSessions === 1 ? '' : 's'}</div>`,
    `<div><strong>${summary.segments}</strong> transcript segment${summary.segments === 1 ? '' : 's'}</div>`,
  ].join('');
}

function pickSpeakerCaptureMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];

  if (typeof MediaRecorder.isTypeSupported !== 'function') {
    return candidates[0];
  }

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
}

function formatSpeakerLabel(label) {
  if (!label) return '';
  return String(label).startsWith('Speaker ') ? String(label) : `Speaker ${label}`;
}

function parseSpeakerNames(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/[\n,]/)
        .map((name) => name.trim())
        .filter(Boolean)
    )
  ).slice(0, 8);
}

function normalizeSpeakerNamesInput(value) {
  return parseSpeakerNames(value).join(', ');
}

function getDefaultSpeakerLabel(rawLabel) {
  return rawLabel ? formatSpeakerLabel(rawLabel) : '';
}

function getSegmentRawSpeakerLabel(segment) {
  if (segment?.speakerRawLabel) return String(segment.speakerRawLabel).trim();
  const match = String(segment?.speakerLabel || '')
    .trim()
    .match(/^Speaker\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function buildSpeakerAliasesFromNames(speakerNames) {
  return parseSpeakerNames(speakerNames).reduce((aliases, name, index) => {
    const rawLabel = String.fromCharCode(65 + index);
    aliases[rawLabel] = name;
    return aliases;
  }, {});
}

function resolveSpeakerLabel(rawLabel, session, fallbackLabel = '') {
  const normalizedRawLabel = String(rawLabel || '').trim();
  if (!normalizedRawLabel) return fallbackLabel || '';
  const alias = session?.speakerAliases?.[normalizedRawLabel];
  const seededLabel = buildSpeakerAliasesFromNames(session?.speakerNames || '')[normalizedRawLabel];
  return alias?.trim() || seededLabel?.trim() || fallbackLabel || getDefaultSpeakerLabel(normalizedRawLabel);
}

function getSpeakerNamesForContext(session = state.currentSession) {
  const seededNames = parseSpeakerNames(session?.speakerNames || state.settings.speakerNames || '');
  const aliasEntries = Object.entries(session?.speakerAliases || {})
    .map(([rawLabel, label]) => [String(rawLabel || '').trim(), String(label || '').trim()])
    .filter(([rawLabel, label]) => rawLabel && label)
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));

  const aliasMap = new Map(aliasEntries);
  const merged = [];

  seededNames.forEach((name, index) => {
    const rawLabel = String.fromCharCode(65 + index);
    merged.push(aliasMap.get(rawLabel) || name);
    aliasMap.delete(rawLabel);
  });

  aliasEntries.forEach(([rawLabel, label]) => {
    if (aliasMap.has(rawLabel)) {
      merged.push(label);
      aliasMap.delete(rawLabel);
    }
  });

  return Array.from(new Set(merged.map((name) => name.trim()).filter(Boolean)));
}

function buildSessionGlossary(session = state.currentSession) {
  const glossary = String(session?.glossary || state.settings.glossary || '').trim();
  const speakerNames = getSpeakerNamesForContext(session);
  if (!speakerNames.length) return glossary;

  const speakerLine = `Speaker names: ${speakerNames.join(', ')}`;
  if (!glossary) return speakerLine;
  if (glossary.includes(speakerLine)) return glossary;
  return `${glossary}\n${speakerLine}`;
}

function overlapMs(startA, endA, startB, endB) {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function computeWordOverlapScore(firstText, secondText) {
  const firstWords = normalizeTranscript(firstText)
    .split(' ')
    .filter((word) => word.length > 2);
  const secondWords = normalizeTranscript(secondText)
    .split(' ')
    .filter((word) => word.length > 2);

  if (!firstWords.length || !secondWords.length) return 0;

  const firstSet = new Set(firstWords);
  const secondSet = new Set(secondWords);
  let shared = 0;
  firstSet.forEach((word) => {
    if (secondSet.has(word)) shared += 1;
  });

  return shared / Math.max(1, Math.min(firstSet.size, secondSet.size));
}

function buildSpeakerSummary(segments) {
  const summaryMap = new Map();

  for (const segment of segments) {
    const rawLabel = getSegmentRawSpeakerLabel(segment);
    const label = segment.speakerLabel || getDefaultSpeakerLabel(rawLabel);
    if (!label) continue;
    const key = rawLabel || label;
    const current = summaryMap.get(key) || {
      label,
      rawLabel,
      defaultLabel: getDefaultSpeakerLabel(rawLabel),
      durationMs: 0,
      segments: 0,
    };
    current.durationMs += Math.max(1000, segment.speakerDurationMs || segment.endMs - segment.startMs || 0);
    current.segments += 1;
    summaryMap.set(key, current);
  }

  return Array.from(summaryMap.values()).sort((a, b) => b.durationMs - a.durationMs || a.label.localeCompare(b.label));
}

function renderSpeakerSummaryCards(summary) {
  if (!summary.length) return '';

  const totalDurationMs = summary.reduce((total, speaker) => total + speaker.durationMs, 0);

  return [
    `
      <div class="speaker-total">
        <strong>Total speaker time</strong>
        <span>${formatDuration(totalDurationMs)}</span>
        <small>Best effort, based on diarized segments only.</small>
      </div>
    `,
    ...summary.map(
      (speaker) => `
        <div class="speaker-stat">
          <div class="speaker-stat__content">
            <div class="speaker-stat__header-row">
              <strong>${escapeHtml(speaker.label)}</strong>
              ${
                speaker.rawLabel
                  ? `<button class="button button--ghost button--small" data-speaker-action="rename" data-speaker-raw-label="${escapeHtml(
                      speaker.rawLabel
                    )}">Rename</button>`
                  : ''
              }
            </div>
            <small>${escapeHtml(
              [
                speaker.defaultLabel && speaker.defaultLabel !== speaker.label ? speaker.defaultLabel : null,
                `${speaker.segments} segment${speaker.segments === 1 ? '' : 's'}`,
              ]
                .filter(Boolean)
                .join(' • ')
            )}</small>
          </div>
          <span>${formatDuration(speaker.durationMs)}</span>
        </div>
      `
    ),
  ].join('');
}

function renderSpeakerInsights() {
  if (!elements.speakerStatusLine || !elements.speakerSummary) return;

  const session = state.currentSession;
  const pendingSegments = state.currentSegments.filter((segment) => segment.speakerStatus === 'pending').length;
  const summary = buildSpeakerSummary(state.currentSegments);
  const sessionEnded = session?.status === 'ended';
  const stoppedSession = session && ['paused', 'ended'].includes(session.status);

  if (!session) {
    elements.speakerStatusLine.textContent = 'Speaker detection will appear here when a session is active.';
    elements.speakerSummary.innerHTML = '<div class="note">No speaker timing data yet.</div>';
    return;
  }

  if (!state.speakerTrackingSupported) {
    elements.speakerStatusLine.textContent = 'This browser does not support background speaker detection.';
    elements.speakerSummary.innerHTML = summary.length
      ? renderSpeakerSummaryCards(summary)
      : '<div class="note">Speaker timing is unavailable in this browser.</div>';
    return;
  }

  if (pendingSegments) {
    elements.speakerStatusLine.textContent = `${state.speakerTrackingStatus} ${pendingSegments} segment${pendingSegments === 1 ? '' : 's'} still waiting.`;
  } else if (sessionEnded && summary.length) {
    elements.speakerStatusLine.textContent = 'Session ended. Final speaker totals stay available below and in exports.';
  } else if (sessionEnded) {
    elements.speakerStatusLine.textContent = 'Session ended. No finalized speaker timing is available for this session.';
  } else if (stoppedSession && summary.length) {
    elements.speakerStatusLine.textContent = 'Capture stopped. Final speaker totals stay available below and in exports.';
  } else if (stoppedSession) {
    elements.speakerStatusLine.textContent = 'Capture stopped. No finalized speaker timing is available for this session.';
  } else {
    elements.speakerStatusLine.textContent = state.speakerTrackingStatus;
  }

  if (!summary.length) {
    elements.speakerSummary.innerHTML =
      '<div class="note">Best-effort speaker timing runs in the background and may lag by roughly 20 to 40 seconds.</div>';
    return;
  }

  elements.speakerSummary.innerHTML = renderSpeakerSummaryCards(summary);
}

function buildTranscriptTimestamp(segment) {
  const style = state.settings.timestampStyle || 'elapsed';
  if (style === 'wall-clock') return formatShortTime(segment.createdAt);
  if (style === 'speech-only') return formatDuration(segment.speechEndMs || segment.endMs || 0);
  return formatDuration(segment.endMs || 0);
}

function renderSessionSummary() {
  const session = state.currentSession;
  if (!session) {
    elements.sessionTitle.textContent = 'No active session';
    elements.sessionMeta.textContent = 'Start a session to begin.';
    elements.durationValue.textContent = '00:00';
    elements.speechOnlyValue.textContent = '00:00';
    elements.segmentCountValue.textContent = '0';
    return;
  }

  elements.sessionTitle.textContent = session.title;
  elements.sessionMeta.textContent = buildSessionMeta(session);
  elements.durationValue.textContent = formatDuration(getEffectiveActiveDuration());
  elements.speechOnlyValue.textContent = formatDuration(getEffectiveSpeechDuration());
  elements.segmentCountValue.textContent = String(state.currentSegments.length);
}

function buildLiveTranscriptState() {
  const session = state.currentSession;
  const sourceLabel = getLanguageName(session?.sourceLanguage || state.settings.sourceLanguage || '');
  const targetLabel = getLanguageName(session?.targetLanguage || state.settings.targetLanguage || '');

  if (!session) {
    return {
      visible: false,
      sourceLabel,
      targetLabel,
      liveStateLabel: 'Start listening to build the live bilingual timeline.',
    };
  }

  const sourceDraft = String(session.draftSource || '').trim();
  const targetDraft = String(session.draftTranslation || '').trim();
  const hasActiveSpeech = Boolean(sourceDraft) && (state.speechActive || Boolean(state.activeDraftItemId));
  const targetRefreshing = Boolean(
    sourceDraft &&
      ((state.draftTranslationPending && state.draftTranslationPending.itemId === state.activeDraftItemId) ||
        (state.draftTranslationActive && state.draftTranslationActive.itemId === state.activeDraftItemId))
  );

  let liveStateLabel = state.settings.autoScroll
    ? 'Following the newest lines automatically.'
    : 'Auto-follow is off. Scroll manually or use Jump to live.';

  if (!state.transcriptPinnedToBottom && (state.currentSegments.length || sourceDraft || targetDraft)) {
    liveStateLabel = 'Browsing earlier lines. Tap Jump to live to rejoin the current speech.';
  } else if (hasActiveSpeech && targetDraft) {
    liveStateLabel = 'Original and translation are updating in place.';
  } else if (hasActiveSpeech) {
    liveStateLabel = 'Listening live. Translation is catching up.';
  } else if (sourceDraft && targetDraft) {
    liveStateLabel = 'Holding the current utterance until the final segment lands.';
  } else if (sourceDraft) {
    liveStateLabel = 'Holding the current utterance while translation settles.';
  } else if (!state.currentSegments.length) {
    liveStateLabel = 'Waiting for the first utterance.';
  }

  return {
    visible: Boolean(sourceDraft || targetDraft),
    sourceLabel,
    targetLabel,
    sourceText: sourceDraft || (targetDraft ? 'Source text is settling…' : ''),
    targetText: targetDraft || (sourceDraft ? 'Translation is catching up…' : ''),
    liveStateLabel,
    liveBadge: hasActiveSpeech ? 'Live' : 'Holding',
    liveMeta: hasActiveSpeech ? 'Updating while the speaker talks' : 'Waiting for final lock-in',
    timestamp: formatDuration(getEffectiveActiveDuration()),
    targetPending: Boolean(sourceDraft && !targetDraft),
    hasActiveSpeech,
  };
}

function renderDrafts() {
  const liveDraft = buildLiveTranscriptState();
  if (elements.transcriptSourceHeading) elements.transcriptSourceHeading.textContent = liveDraft.sourceLabel;
  if (elements.transcriptTargetHeading) elements.transcriptTargetHeading.textContent = liveDraft.targetLabel;
  if (elements.transcriptLiveState) elements.transcriptLiveState.textContent = liveDraft.liveStateLabel;
  renderTranscript();
}

function renderTranscript() {
  const list = elements.transcriptList;
  const liveDraft = buildLiveTranscriptState();
  const sourceLabel = liveDraft.sourceLabel;
  const targetLabel = liveDraft.targetLabel;
  const keepPinnedDuringCapture = Boolean(
    state.settings.autoScroll &&
      state.currentSession &&
      ['connecting', 'listening', 'reconnecting'].includes(state.runtimeStatus)
  );
  const shouldFollow = Boolean(
    state.settings.autoScroll && (keepPinnedDuringCapture || state.transcriptPinnedToBottom || list.scrollHeight <= list.clientHeight + 32)
  );
  const previousScrollTop = list.scrollTop;

  const finalizedRows = state.currentSegments.map((segment) => {
    const translatedText = String(segment.translatedText || segment.translatedDraft || '').trim();
    const translationPending = !translatedText && segment.translationStatus !== 'error';
    const translatedDisplay = translatedText || (segment.translationStatus === 'error' ? 'Translation unavailable.' : 'Translating…');
    const speakerLabel = segment.speakerLabel
      ? segment.speakerLabel
      : segment.speakerStatus === 'pending'
        ? 'Speaker analyzing…'
        : segment.speakerStatus === 'error'
          ? 'Speaker unavailable'
          : 'Speaker';
    const auxParts = [];
    if (segment.sequence) auxParts.push(`Segment ${segment.sequence}`);
    if (segment.translationStatus === 'draft') auxParts.push('Translation polishing');
    else if (translationPending) auxParts.push('Translation pending');

    return `
      <article class="transcript-row transcript-row--final">
        <div class="transcript-row__meta">
          <strong class="transcript-row__time">${escapeHtml(buildTranscriptTimestamp(segment))}</strong>
          <span class="transcript-row__speaker">${escapeHtml(speakerLabel)}</span>
          <span class="transcript-row__aux">${escapeHtml(auxParts.join(' • ') || 'Finalized')}</span>
        </div>
        <div class="transcript-cell transcript-cell--source">
          <span class="transcript-cell__label">${escapeHtml(sourceLabel)}</span>
          <p class="transcript-cell__text">${escapeHtml(segment.sourceText)}</p>
        </div>
        <div class="transcript-cell transcript-cell--target">
          <span class="transcript-cell__label">${escapeHtml(targetLabel)}</span>
          <p class="transcript-cell__text ${translationPending ? 'transcript-cell__text--pending' : ''}">${escapeHtml(translatedDisplay)}</p>
        </div>
      </article>
    `;
  });

  const liveRow = liveDraft.visible
    ? `
      <article class="transcript-row transcript-row--live">
        <div class="transcript-row__meta">
          <strong class="transcript-row__time">${escapeHtml(liveDraft.timestamp || 'Live')}</strong>
          <span class="transcript-row__speaker">${escapeHtml(liveDraft.liveBadge)}</span>
          <span class="transcript-row__state">${escapeHtml(liveDraft.liveMeta)}</span>
        </div>
        <div class="transcript-cell transcript-cell--source">
          <span class="transcript-cell__label">${escapeHtml(sourceLabel)}</span>
          <p class="transcript-cell__text ${liveDraft.hasActiveSpeech ? 'transcript-cell__text--live' : 'transcript-cell__text--held'}">${escapeHtml(
            liveDraft.sourceText || 'Listening…'
          )}</p>
        </div>
        <div class="transcript-cell transcript-cell--target">
          <span class="transcript-cell__label">${escapeHtml(targetLabel)}</span>
          <p class="transcript-cell__text ${liveDraft.targetPending ? 'transcript-cell__text--pending' : 'transcript-cell__text--live'}">${escapeHtml(
            liveDraft.targetText || 'Translation is catching up…'
          )}</p>
        </div>
      </article>
    `
    : '';

  if (!finalizedRows.length && !liveRow) {
    list.innerHTML = '<div class="transcript-empty">Start speaking and the live bilingual timeline will grow here.</div>';
    updateTranscriptAutoFollowState();
    return;
  }

  list.innerHTML = [...finalizedRows, liveRow].join('');

  requestAnimationFrame(() => {
    if (shouldFollow) {
      list.scrollTop = list.scrollHeight;
      requestAnimationFrame(() => {
        list.scrollTop = list.scrollHeight;
        state.transcriptPinnedToBottom = true;
        updateTranscriptAutoFollowState();
      });
    } else {
      list.scrollTop = previousScrollTop;
      updateTranscriptAutoFollowState();
    }
  });
}

function upsertCurrentSegmentInState(segment) {
  const index = state.currentSegments.findIndex((item) => item.id === segment.id);
  if (index === -1) {
    state.currentSegments.push(segment);
  } else {
    state.currentSegments[index] = {
      ...state.currentSegments[index],
      ...segment,
    };
  }

  state.currentSegments.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  if (state.currentSession) {
    state.currentSession.segmentCount = state.currentSegments.length;
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHistory() {
  if (!state.sessions.length) {
    elements.historyList.innerHTML = '<div class="note">No local sessions yet.</div>';
    return;
  }

  elements.historyList.innerHTML = state.sessions
    .map((session) => {
      const duration = formatDuration(session.activeDurationMs || 0);
      const status = session.status === 'ended' ? 'Ended' : session.status === 'paused' ? 'Paused' : 'Active';
      return `
        <article class="history-card" data-session-card-id="${session.id}">
          <div class="history-card__header">
            <div>
              <h4>${escapeHtml(session.title)}</h4>
              <div class="history-card__meta">
                <span>${slugDate(session.createdAt)}</span>
                <span>${getLanguageName(session.sourceLanguage)} → ${getLanguageName(session.targetLanguage)}</span>
                <span>${duration}</span>
                <span>${session.segmentCount || 0} segment${(session.segmentCount || 0) === 1 ? '' : 's'}</span>
                <span>${status}</span>
              </div>
            </div>
          </div>
          <div class="history-card__actions">
            <button class="button button--secondary button--small" data-history-action="open" data-session-id="${session.id}">Open</button>
            <button class="button button--ghost button--small" data-history-action="rename" data-session-id="${session.id}">Rename</button>
            <button class="button button--ghost button--small" data-history-action="export-md" data-session-id="${session.id}">Markdown</button>
            <button class="button button--ghost button--small" data-history-action="export-txt" data-session-id="${session.id}">TXT</button>
            <button class="button button--ghost button--small" data-history-action="export-json" data-session-id="${session.id}">JSON</button>
            <button class="button button--danger button--small" data-history-action="delete" data-session-id="${session.id}">Delete</button>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderControls() {
  const session = state.currentSession;
  const runtime = state.runtimeStatus;
  const ended = !session || session.status === 'ended';
  const canStart = session && !ended && !['connecting', 'listening', 'reconnecting'].includes(runtime);
  const canPause = session && runtime === 'listening';
  const canResume = session && !ended && ['paused', 'stopped', 'error'].includes(runtime);
  const canStop = session && !ended && ['listening', 'connecting', 'reconnecting'].includes(runtime);

  elements.startButton.classList.toggle('hidden', !canStart || runtime === 'paused');
  elements.pauseButton.classList.toggle('hidden', !canPause);
  elements.resumeButton.classList.toggle('hidden', !canResume);
  elements.stopButton.classList.toggle('hidden', !canStop);
  elements.endSessionButton.disabled = !session || ended;
  elements.renameSessionButton.disabled = !session;
  elements.exportMarkdownButton.disabled = !session || !state.currentSegments.length;
  elements.exportTxtButton.disabled = !session || !state.currentSegments.length;
  elements.exportJsonButton.disabled = !session || !state.currentSegments.length;
  elements.exportCurrentFromSide.disabled = !session || !state.currentSegments.length;
}

function renderResumeButtons() {
  const resumeCandidate = state.sessions.find((session) => session.id === state.lastActiveSessionId && session.status !== 'ended');
  const hasResumable = Boolean(resumeCandidate);
  elements.resumeLastSessionButton.classList.toggle('hidden', !hasResumable);
  elements.recoverDraftButton.classList.toggle('hidden', !hasResumable);
}

async function syncLastActiveSession() {
  if (state.currentSession && state.currentSession.status !== 'ended') {
    state.lastActiveSessionId = state.currentSession.id;
    await setMeta('lastActiveSessionId', state.currentSession.id);
  } else {
    state.lastActiveSessionId = null;
    await deleteMeta('lastActiveSessionId');
  }
}

async function createSession({ sourceLanguage, targetLanguage, glossary, speakerNames }) {
  const createdAt = nowIso();
  const normalizedSpeakerNames = normalizeSpeakerNamesInput(speakerNames);
  const session = {
    id: crypto.randomUUID(),
    title: buildSessionTitle(createdAt, sourceLanguage, targetLanguage),
    status: 'paused',
    runtimeStatus: 'idle',
    sourceLanguage,
    targetLanguage,
    glossary: glossary || '',
    speakerNames: normalizedSpeakerNames,
    speakerAliases: {},
    createdAt,
    updatedAt: createdAt,
    activeDurationMs: 0,
    speechOnlyMs: 0,
    segmentCount: 0,
    draftSource: '',
    draftTranslation: '',
    lastSequence: 0,
  };

  await upsertSession(session);
  return session;
}

async function loadSession(sessionId) {
  const session = await getSession(sessionId);
  if (!session) return null;
  state.currentSession = session;
  state.currentSegments = await listSegmentsBySession(sessionId);
  state.speechActive = false;
  clearLiveDraftCarry();
  state.speakerTrackingStatus = state.speakerTrackingSupported
    ? 'Speaker timing is a best-effort background feature and may lag slightly.'
    : 'This browser does not support background speaker detection.';
  state.draftByItemId.clear();
  state.commitMetaByItemId.clear();
  state.activeDraftItemId = null;
  state.transcriptPinnedToBottom = true;
  flushListeningClock();
  flushSpeechClock();
  setStatus(session.runtimeStatus || (session.status === 'ended' ? 'ended' : 'stopped'), session.status === 'ended' ? 'Session ended.' : 'Session loaded.');
  renderCurrentView();
  return session;
}

function renderCurrentView() {
  applySettingsToForms();
  renderSessionSummary();
  renderDrafts();
  renderSpeakerInsights();
  renderHistory();
  renderControls();
}

function stopSpeakerTracks(stream) {
  stream?.getTracks?.().forEach((track) => {
    try {
      track.stop();
    } catch {
      // ignore
    }
  });
}

async function stopSpeakerTracking({ statusMessage } = {}) {
  const recorder = state.speakerRecorder;

  if (recorder && recorder.state !== 'inactive') {
    await new Promise((resolve) => {
      recorder.addEventListener('stop', resolve, { once: true });
      recorder.stop();
    }).catch(() => {});
  }

  stopSpeakerTracks(state.speakerStream);
  state.speakerRecorder = null;
  state.speakerStream = null;
  state.speakerMimeType = '';
  state.speakerChunkStartMs = 0;
  state.speakerTrackingSessionId = null;

  if (statusMessage) {
    state.speakerTrackingStatus = statusMessage;
    renderSpeakerInsights();
  }
}

async function applySpeakerLabelsFromDiarizedChunk({ sessionId, chunkStartMs, chunkEndMs, diarizedSegments }) {
  const session = state.currentSession?.id === sessionId ? state.currentSession : await getSession(sessionId);
  const sessionSegments = state.currentSession?.id === sessionId ? [...state.currentSegments] : await listSegmentsBySession(sessionId);
  const relevantSegments = sessionSegments.filter(
    (segment) => (segment.endMs || 0) >= chunkStartMs - SPEAKER_MATCH_MARGIN_MS && (segment.startMs || 0) <= chunkEndMs + SPEAKER_MATCH_MARGIN_MS
  );

  if (!relevantSegments.length) return 0;

  const speakerSpans = diarizedSegments
    .map((segment) => ({
      label: formatSpeakerLabel(segment.speaker),
      rawSpeaker: segment.speaker,
      text: segment.text || '',
      startMs: chunkStartMs + Math.round(Number(segment.start || 0) * 1000),
      endMs: chunkStartMs + Math.round(Number(segment.end || 0) * 1000),
    }))
    .filter((segment) => segment.label && segment.endMs > segment.startMs);

  if (!speakerSpans.length) return 0;

  let applied = 0;

  for (const transcriptSegment of relevantSegments) {
    const segmentStartMs = Number(transcriptSegment.startMs || 0);
    const segmentEndMs = Number(transcriptSegment.endMs || segmentStartMs);
    const segmentDurationMs = Math.max(600, segmentEndMs - segmentStartMs);
    let bestMatch = null;

    for (const speakerSpan of speakerSpans) {
      const sharedMs = overlapMs(segmentStartMs, segmentEndMs, speakerSpan.startMs, speakerSpan.endMs);
      const timeScore = sharedMs / segmentDurationMs;
      const textScore = computeWordOverlapScore(transcriptSegment.sourceText, speakerSpan.text);
      const score = timeScore + textScore * 0.45;

      if (!bestMatch || score > bestMatch.score) {
        bestMatch = {
          ...speakerSpan,
          sharedMs,
          timeScore,
          textScore,
          score,
        };
      }
    }

    if (!bestMatch) continue;
    if (bestMatch.score < 0.22 && bestMatch.textScore < 0.5) continue;

    const existingScore = Number(transcriptSegment.speakerScore || 0);
    if (transcriptSegment.speakerLabel && existingScore >= bestMatch.score + 0.05) continue;

    const updatedSegment = {
      ...transcriptSegment,
      speakerRawLabel: bestMatch.rawSpeaker,
      speakerLabel: resolveSpeakerLabel(bestMatch.rawSpeaker, session, bestMatch.label),
      speakerScore: Number(bestMatch.score.toFixed(3)),
      speakerConfidence: Math.min(1, Number((bestMatch.timeScore + bestMatch.textScore * 0.25).toFixed(3))),
      speakerDurationMs: Math.max(transcriptSegment.speakerDurationMs || 0, Math.round(bestMatch.sharedMs || 0)),
      speakerStatus: 'done',
      speakerUpdatedAt: nowIso(),
    };

    await upsertSegment(updatedSegment);
    if (state.currentSession?.id === sessionId) {
      upsertCurrentSegmentInState(updatedSegment);
    }
    applied += 1;
  }

  if (applied && state.currentSession?.id === sessionId) {
    renderTranscript();
    renderSpeakerInsights();
  }

  return applied;
}

function queueSpeakerAttribution(chunk) {
  state.speakerTrackingPendingChunks += 1;
  if (state.currentSession?.id === chunk.sessionId) {
    state.speakerTrackingStatus = 'Analyzing recent speaker turns in the background...';
    renderSpeakerInsights();
  }

  state.speakerAttributionQueue = state.speakerAttributionQueue
    .then(async () => {
      state.speakerTrackingInFlight = true;
      const filenameExtension = chunk.mimeType.includes('mp4') ? 'm4a' : chunk.mimeType.includes('ogg') ? 'ogg' : 'webm';
      const diarized = await diarizeAudioChunk({
        apiKey: state.settings.apiKey,
        audioBlob: chunk.blob,
        filename: `speaker-chunk-${chunk.index}.${filenameExtension}`,
        language: chunk.sourceLanguage,
      });

      await applySpeakerLabelsFromDiarizedChunk({
        sessionId: chunk.sessionId,
        chunkStartMs: chunk.startMs,
        chunkEndMs: chunk.endMs,
        diarizedSegments: diarized.segments,
      });

      if (state.currentSession?.id === chunk.sessionId) {
        state.speakerTrackingStatus = 'Speaker timing updated. Best effort and intentionally slightly delayed.';
      }
    })
    .catch((error) => {
      console.warn('Speaker diarization failed', error);
      if (state.currentSession?.id === chunk.sessionId) {
        state.speakerTrackingStatus = 'Speaker timing is catching up. The live transcript remains prioritized.';
      }
    })
    .finally(() => {
      state.speakerTrackingPendingChunks = Math.max(0, state.speakerTrackingPendingChunks - 1);
      state.speakerTrackingInFlight = false;
      if (state.currentSession?.id === chunk.sessionId) {
        renderSpeakerInsights();
      }
    });
}

async function startSpeakerTracking(stream) {
  await stopSpeakerTracking();

  if (!stream) return;
  if (!state.currentSession) {
    stopSpeakerTracks(stream);
    return;
  }

  if (typeof MediaRecorder === 'undefined') {
    state.speakerTrackingSupported = false;
    state.speakerTrackingStatus = 'This browser does not support background speaker detection.';
    stopSpeakerTracks(stream);
    renderSpeakerInsights();
    return;
  }

  const mimeType = pickSpeakerCaptureMimeType();

  try {
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const sessionId = state.currentSession.id;
    const sourceLanguage = state.currentSession.sourceLanguage;

    state.speakerTrackingSupported = true;
    state.speakerRecorder = recorder;
    state.speakerStream = stream;
    state.speakerMimeType = recorder.mimeType || mimeType || stream.getAudioTracks?.()[0]?.getSettings?.().mimeType || 'audio/webm';
    state.speakerChunkStartMs = getEffectiveActiveDuration();
    state.speakerTrackingSessionId = sessionId;
    state.speakerTrackingStatus = 'Buffering speaker timing in parallel. First results arrive after about 20 seconds.';
    renderSpeakerInsights();

    recorder.addEventListener('dataavailable', (event) => {
      const chunkBlob = event.data;
      const chunkEndMs = getEffectiveActiveDuration();
      const chunkStartMs = state.speakerChunkStartMs;
      state.speakerChunkStartMs = chunkEndMs;

      if (!chunkBlob || chunkBlob.size < SPEAKER_MIN_CHUNK_BYTES || chunkEndMs <= chunkStartMs) {
        return;
      }

      state.speakerChunkIndex += 1;
      queueSpeakerAttribution({
        index: state.speakerChunkIndex,
        blob: chunkBlob,
        startMs: chunkStartMs,
        endMs: chunkEndMs,
        mimeType: chunkBlob.type || state.speakerMimeType || 'audio/webm',
        sessionId,
        sourceLanguage,
      });
    });

    recorder.addEventListener('error', () => {
      state.speakerTrackingStatus = 'Speaker timing is unavailable in this browser session.';
      renderSpeakerInsights();
    });

    recorder.start(SPEAKER_CHUNK_MS);
  } catch (error) {
    console.warn('Unable to start background speaker tracking', error);
    state.speakerTrackingSupported = false;
    state.speakerTrackingStatus = 'Speaker timing could not start here, but live capture still works.';
    stopSpeakerTracks(stream);
    renderSpeakerInsights();
  }
}

async function handleStartFromSetup(event) {
  event.preventDefault();
  const formValues = collectSettingsFromSetupForm();
  if (!formValues.apiKey) {
    showToast('Please enter your OpenAI API key.');
    return;
  }

  await persistSettings({
    ...state.settings,
    ...formValues,
  });

  if (state.currentSession && state.currentSession.status !== 'ended' && state.currentSegments.length === 0) {
    const abandon = window.confirm('Start a new session and leave the current empty session behind?');
    if (!abandon) return;
  }

  const session = await createSession(formValues);
  state.currentSession = session;
  state.currentSegments = [];
  state.transcriptPinnedToBottom = true;
  clearLiveDraftCarry();
  await syncLastActiveSession();
  await refreshSessions();
  renderCurrentView();
  setRoute('live');
  await startListening();
}

async function startListening({ silent = false } = {}) {
  if (!state.currentSession) {
    showToast('Create or open a session first.');
    return;
  }
  if (!state.settings.apiKey) {
    showToast('Please add your OpenAI API key first.');
    setRoute('setup');
    return;
  }
  if (state.currentSession.status === 'ended') {
    showToast('This session is ended. Start a new one to keep capturing.');
    return;
  }
  if (state.client) {
    resetLiveCommitState();
    await stopSpeakerTracking({ statusMessage: 'Refreshing background speaker timing...' });
    await state.client.disconnect({ nextStatus: 'stopped', message: 'Resetting the live connection...' });
    state.client = null;
  }

  resetLiveCommitState();
  state.speechActive = false;
  setStatus('connecting', 'Requesting microphone access and opening a live transcription connection...');
  state.currentSession.status = 'active';
  state.currentSession.runtimeStatus = 'connecting';
  state.currentSession.updatedAt = nowIso();
  await persistCurrentSessionNow();
  await syncLastActiveSession();
  if (state.settings.autoScroll && state.route === 'live') {
    scrollTranscriptToLive('auto');
  }

  const client = new RealtimeTranscriptionClient({
    apiKey: state.settings.apiKey,
    sourceLanguage: state.currentSession.sourceLanguage,
    sourceLanguageName: getLanguageName(state.currentSession.sourceLanguage),
    targetLanguageName: getLanguageName(state.currentSession.targetLanguage),
    glossary: buildSessionGlossary(state.currentSession),
    onEvent: handleRealtimeEvent,
    onStreamAvailable: (stream) => {
      startSpeakerTracking(stream).catch((error) => {
        console.warn('Background speaker tracking failed to start', error);
      });
    },
    onStatus: (status, message) => {
      if (status === 'listening') {
        markListeningStart();
      }
      setStatus(status, message);
      renderSessionSummary();
    },
    onError: async (message) => {
      resetLiveCommitState();
      state.speechActive = false;
      await stopSpeakerTracking({ statusMessage: 'Speaker timing paused because live capture stopped.' });
      flushListeningClock();
      flushSpeechClock();
      setStatus('error', message);
      await persistCurrentSessionNow();
      showToast(message, 5000);
    },
  });

  state.client = client;

  try {
    await client.connect();
    markListeningStart();
    startClockTimer();
    if (!silent) {
      showToast('Live transcription started.');
    }
  } catch (error) {
    resetLiveCommitState();
    state.speechActive = false;
    await stopSpeakerTracking({ statusMessage: 'Speaker timing is idle.' });
    state.client = null;
    const message = error?.message || 'Unable to start live transcription.';
    setStatus('error', message);
    showToast(message, 5000);
  }
}

async function pauseListening() {
  if (!state.client) return;
  resetLiveCommitState();
  flushListeningClock();
  flushSpeechClock();
  state.speechActive = false;
  await stopSpeakerTracking({ statusMessage: 'Paused. Speaker timing may keep catching up for the last buffered audio.' });
  await state.client.disconnect({ nextStatus: 'paused', message: 'Paused. Microphone sending has stopped.' });
  state.client = null;
  state.currentSession.status = 'paused';
  state.currentSession.runtimeStatus = 'paused';
  await persistCurrentSessionNow();
  await syncLastActiveSession();
  renderCurrentView();
}

async function stopListening() {
  if (state.client) {
    resetLiveCommitState();
    flushListeningClock();
    flushSpeechClock();
    state.speechActive = false;
    await stopSpeakerTracking({ statusMessage: 'Stopped. Speaker timing may finish the last buffered chunk.' });
    await state.client.disconnect({ nextStatus: 'stopped', message: 'Stopped. You can start again in the same session.' });
    state.client = null;
  }
  if (state.currentSession) {
    state.currentSession.status = 'paused';
    state.currentSession.runtimeStatus = 'stopped';
    await persistCurrentSessionNow();
    await syncLastActiveSession();
    renderCurrentView();
  }
}

async function endCurrentSession() {
  if (!state.currentSession) return;
  const confirmed = window.confirm('End this session? The transcript stays in local history, but live capture will stop.');
  if (!confirmed) return;

  if (state.client) {
    resetLiveCommitState();
    flushListeningClock();
    flushSpeechClock();
    state.speechActive = false;
    await stopSpeakerTracking({ statusMessage: 'Ending session. Speaker timing may finish the last buffered chunk.' });
    await state.client.disconnect({ nextStatus: 'ended', message: 'Session ended.' });
    state.client = null;
  }

  state.currentSession.status = 'ended';
  state.currentSession.runtimeStatus = 'ended';
  state.currentSession.endedAt = nowIso();
  state.currentSession.updatedAt = nowIso();
  state.currentSession.draftSource = '';
  state.currentSession.draftTranslation = '';
  await persistCurrentSessionNow();
  await syncLastActiveSession();
  await refreshSessions();
  setStatus('ended', 'Session ended. You can reopen it from history or start a new one.');
  renderCurrentView();
  showToast('Session ended.');
}

async function createFreshSessionFromLive() {
  if (state.currentSession && state.currentSession.status !== 'ended') {
    const confirmed = window.confirm('Start a new session? The current one will be stopped but kept in local history.');
    if (!confirmed) return;
    await stopListening();
  }

  elements.apiKeyInput.value = state.settings.apiKey || '';
  elements.sourceLanguageInput.value = state.settings.sourceLanguage;
  elements.targetLanguageInput.value = state.settings.targetLanguage;
  elements.glossaryInput.value = state.currentSession?.glossary || state.settings.glossary || '';
  elements.speakerNamesInput.value = state.currentSession?.speakerNames || state.settings.speakerNames || '';
  setRoute('setup');
}

function buildCommitMeta(itemId, previousItemId) {
  const lastSequence = state.currentSession?.lastSequence || 0;
  const sequence = state.commitMetaByItemId.get(itemId)?.sequence || lastSequence + 1;
  state.currentSession.lastSequence = Math.max(lastSequence, sequence);
  state.commitMetaByItemId.set(itemId, {
    itemId,
    previousItemId,
    sequence,
    committedAtIso: nowIso(),
  });
  scheduleSessionPersist();
}

function updateDraft(itemId, delta) {
  const previousItemId = state.activeDraftItemId;
  const current = state.draftByItemId.get(itemId) || { sourceDraft: '', translatedDraft: '' };
  const switchedItems = previousItemId !== itemId;
  current.sourceDraft = `${current.sourceDraft || ''}${delta || ''}`;
  state.draftByItemId.set(itemId, current);
  state.activeDraftItemId = itemId;
  state.speechActive = true;
  if (state.currentSession) {
    if (switchedItems) {
      captureVisibleDraftCarry(previousItemId);
      state.currentSession.draftTranslation = '';
    }
    state.currentSession.draftSource = current.sourceDraft.trim();
  }
  renderDrafts();
  scheduleSessionPersist(400);
  scheduleDraftTranslation(itemId, current.sourceDraft.trim());
  if (state.speechActive && !state.liveCommitTimer && !state.liveCommitInFlight) {
    scheduleLiveCommit();
  }
}

function clearDraftState(itemId, { preserveVisibleDraft = false } = {}) {
  const draftState = state.draftByItemId.get(itemId);
  const preservedSource = draftState?.sourceDraft?.trim() || state.currentSession?.draftSource || '';
  const preservedTranslation = draftState?.translatedDraft?.trim() || state.currentSession?.draftTranslation || '';

  state.draftByItemId.delete(itemId);
  if (state.draftTranslationPending?.itemId === itemId) {
    state.draftTranslationPending = null;
    window.clearTimeout(state.draftTranslationTimer);
  }
  if (state.draftTranslationActive?.itemId === itemId) {
    state.draftTranslationAbortController?.abort();
  }
  if (state.activeDraftItemId === itemId) {
    state.activeDraftItemId = null;
  }
  if (state.currentSession && state.activeDraftItemId === null) {
    if (preserveVisibleDraft) {
      state.currentSession.draftSource = preservedSource;
      state.currentSession.draftTranslation = preservedTranslation;
      setLiveDraftCarry({ itemId, source: preservedSource, translation: preservedTranslation });
    } else {
      state.currentSession.draftSource = '';
      state.currentSession.draftTranslation = '';
      clearLiveDraftCarry();
    }
  }
  renderDrafts();
}

function scheduleDraftTranslation(itemId, text) {
  if (!state.currentSession) return;

  const trimmedText = text.trim();
  if (!trimmedText || trimmedText.length < DRAFT_TRANSLATION_MIN_CHARS) {
    state.draftTranslationPending = null;
    if (state.activeDraftItemId === itemId) {
      state.currentSession.draftTranslation = '';
      renderDrafts();
    }
    return;
  }

  state.draftTranslationPending = {
    itemId,
    text: trimmedText,
    sessionId: state.currentSession.id,
  };

  const active = state.draftTranslationActive;
  const shouldAbortInFlight =
    state.draftTranslationInFlight &&
    active &&
    (
      active.itemId !== itemId ||
      (trimmedText !== active.text &&
        (trimmedText.length - (active.text?.length || 0) >= DRAFT_TRANSLATION_ABORT_GROWTH_CHARS ||
          /[.!?,:;]\s*$/.test(trimmedText)))
    );

  if (shouldAbortInFlight) {
    state.draftTranslationAbortController?.abort();
  }

  processDraftTranslationQueue();
}

function processDraftTranslationQueue() {
  if (!state.currentSession || !state.draftTranslationPending) return;
  if (state.draftTranslationInFlight) return;

  const waitMs = Math.max(0, DRAFT_TRANSLATION_INTERVAL_MS - (Date.now() - state.draftTranslationLastStartedAt));
  window.clearTimeout(state.draftTranslationTimer);
  state.draftTranslationTimer = window.setTimeout(async () => {
    const snapshot = state.draftTranslationPending;
    if (!snapshot || !state.currentSession) return;

    const controller = new AbortController();
    state.draftTranslationInFlight = true;
    state.draftTranslationActive = snapshot;
    state.draftTranslationAbortController = controller;
    state.draftTranslationLastStartedAt = Date.now();
    renderDrafts();

    try {
      const translated = await translateText({
        apiKey: state.settings.apiKey,
        sourceLanguageName: getLanguageName(state.currentSession.sourceLanguage),
        targetLanguageName: getLanguageName(state.currentSession.targetLanguage),
        glossary: buildSessionGlossary(state.currentSession),
        sourceText: snapshot.text,
        draft: true,
        signal: controller.signal,
      });

      if (!state.currentSession || state.currentSession.id !== snapshot.sessionId) return;

      const draftState = state.draftByItemId.get(snapshot.itemId);
      if (draftState) {
        draftState.translatedDraft = translated || draftState.translatedDraft || '';
        state.draftByItemId.set(snapshot.itemId, draftState);
      }

      if (state.activeDraftItemId === snapshot.itemId) {
        state.currentSession.draftTranslation = translated || state.currentSession.draftTranslation || '';
        renderDrafts();
        scheduleSessionPersist(400);
      }

      const isStillLatest =
        state.draftTranslationPending &&
        state.draftTranslationPending.itemId === snapshot.itemId &&
        state.draftTranslationPending.text === snapshot.text;

      if (isStillLatest) {
        state.draftTranslationPending = null;
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.warn('Draft translation failed', error);
      }
      const isStillLatest =
        state.draftTranslationPending &&
        state.draftTranslationPending.itemId === snapshot.itemId &&
        state.draftTranslationPending.text === snapshot.text;
      if (isStillLatest) {
        state.draftTranslationPending = null;
      }
    } finally {
      if (state.draftTranslationAbortController === controller) {
        state.draftTranslationAbortController = null;
      }
      if (state.draftTranslationActive?.itemId === snapshot.itemId && state.draftTranslationActive?.text === snapshot.text) {
        state.draftTranslationActive = null;
      }
      state.draftTranslationInFlight = false;
      renderDrafts();

      const hasNewerPending =
        state.draftTranslationPending &&
        (state.draftTranslationPending.itemId !== snapshot.itemId ||
          state.draftTranslationPending.text !== snapshot.text);

      if (hasNewerPending) {
        processDraftTranslationQueue();
      }
    }
  }, waitMs);
}

function queueFinalSegmentTranslation(segment) {
  const translationContext = {
    apiKey: state.settings.apiKey,
    sourceLanguageName: getLanguageName(segment.sourceLanguage),
    targetLanguageName: getLanguageName(segment.targetLanguage),
    glossary: buildSessionGlossary(state.currentSession),
    sourceText: segment.sourceText,
    draft: false,
  };

  state.finalTranslationQueue = state.finalTranslationQueue
    .then(async () => {
      state.finalTranslationInFlight = true;
      renderDrafts();

      const translatedText = await translateText(translationContext);
      const mergedSegment = {
        ...(state.currentSegments.find((item) => item.id === segment.id) || segment),
        translatedText: translatedText || segment.translatedText || '',
        translatedDraft: translatedText || segment.translatedDraft || '',
        translationStatus: 'done',
        updatedAt: nowIso(),
      };

      await upsertSegment(mergedSegment);
      if (state.currentSession?.id === segment.sessionId) {
        upsertCurrentSegmentInState(mergedSegment);
        const carryMatchesSegment = Boolean(
          translatedText &&
            (state.liveDraftCarryItemId === segment.itemId ||
              (state.liveDraftCarrySource &&
                normalizeTranscript(state.liveDraftCarrySource) === normalizeTranscript(segment.sourceText)))
        );
        if (carryMatchesSegment && !state.liveDraftCarryTranslation) {
          setLiveDraftCarry({
            itemId: segment.itemId,
            source: state.liveDraftCarrySource || segment.sourceText,
            translation: translatedText,
          });
        }
        if (!state.activeDraftItemId && state.currentSession.draftSource?.trim() === segment.sourceText.trim()) {
          state.currentSession.draftTranslation = translatedText || state.currentSession.draftTranslation || '';
          renderDrafts();
        }
        renderTranscript();
      }
    })
    .catch(async (error) => {
      console.error('Final translation failed', error);
      const mergedSegment = {
        ...(state.currentSegments.find((item) => item.id === segment.id) || segment),
        translationStatus: 'error',
        updatedAt: nowIso(),
      };
      await upsertSegment(mergedSegment).catch(() => {});
      if (state.currentSession?.id === segment.sessionId) {
        upsertCurrentSegmentInState(mergedSegment);
        renderTranscript();
      }
      showToast(error?.message || 'A segment translation failed.', 5000);
    })
    .finally(() => {
      state.finalTranslationInFlight = false;
      renderDrafts();
      processDraftTranslationQueue();
    });
}

async function finalizeSegmentFromEvent(event) {
  if (!state.currentSession) return;
  const itemId = event.item_id;
  const sourceText = String(event.transcript || state.draftByItemId.get(itemId)?.sourceDraft || '').trim();
  if (!sourceText) {
    clearDraftState(itemId);
    return;
  }

  const normalized = normalizeTranscript(sourceText);
  const lastSegment = state.currentSegments[state.currentSegments.length - 1];
  if (lastSegment && (lastSegment.itemId === itemId || normalizeTranscript(lastSegment.sourceText) === normalized)) {
    clearDraftState(itemId, { preserveVisibleDraft: true });
    return;
  }

  const commitMeta = state.commitMetaByItemId.get(itemId) || {
    sequence: (state.currentSession.lastSequence || 0) + 1,
    committedAtIso: nowIso(),
  };
  state.currentSession.lastSequence = Math.max(state.currentSession.lastSequence || 0, commitMeta.sequence || 0);

  const draftState = state.draftByItemId.get(itemId);
  const draftTranslation =
    draftState?.translatedDraft || (state.activeDraftItemId === itemId ? state.currentSession.draftTranslation : '');

  const endMs = getEffectiveActiveDuration();
  const previousSegment = state.currentSegments[state.currentSegments.length - 1];
  const startMs = previousSegment?.endMs || Math.max(0, endMs - Math.max(1000, Math.round(sourceText.length * 75)));

  const segment = {
    id: `${state.currentSession.id}:${itemId || crypto.randomUUID()}`,
    sessionId: state.currentSession.id,
    realtimeConnectionId: state.currentSession.activeConnectionId || commitMeta.realtimeConnectionId,
    itemId,
    sequence: commitMeta.sequence,
    startMs,
    endMs,
    speechEndMs: getEffectiveSpeechDuration(),
    sourceLanguage: state.currentSession.sourceLanguage,
    targetLanguage: state.currentSession.targetLanguage,
    sourceText,
    translatedText: draftTranslation || '',
    sourceDraft: sourceText,
    translatedDraft: draftTranslation || '',
    translationStatus: draftTranslation ? 'draft' : 'pending',
    speakerStatus: state.speakerTrackingSupported ? 'pending' : 'unsupported',
    createdAt: commitMeta.committedAtIso || nowIso(),
  };

  upsertCurrentSegmentInState(segment);
  await upsertSegment(segment);
  clearDraftState(itemId, { preserveVisibleDraft: true });
  await persistCurrentSessionNow();
  renderCurrentView();
  queueFinalSegmentTranslation(segment);
}

async function handleRealtimeEvent(event) {
  if (!state.currentSession) return;

  if (event.type === 'session.created') {
    state.currentSession.activeConnectionId = event.session?.id || event.session_id || crypto.randomUUID();
    await persistCurrentSessionNow();
    return;
  }

  if (event.type === 'input_audio_buffer.speech_started') {
    state.speechActive = true;
    state.liveCommitInFlight = false;
    state.lastLiveCommitAtMs = 0;
    markSpeechStart();
    scheduleLiveCommit();
    renderDrafts();
    return;
  }

  if (event.type === 'input_audio_buffer.speech_stopped') {
    state.speechActive = false;
    state.liveCommitInFlight = false;
    clearLiveCommitTimer();
    flushSpeechClock();
    renderSessionSummary();
    renderDrafts();
    scheduleSessionPersist();
    return;
  }

  if (event.type === 'input_audio_buffer.committed') {
    state.liveCommitInFlight = false;
    state.lastLiveCommitAtMs = Date.now();
    buildCommitMeta(event.item_id, event.previous_item_id);
    if (state.speechActive) {
      scheduleLiveCommit();
    }
    return;
  }

  if (event.type === 'transcripto.manual_commit.rejected') {
    state.liveCommitInFlight = false;
    state.lastLiveCommitAtMs = Date.now();
    if (state.speechActive) {
      scheduleLiveCommit();
    }
    return;
  }

  if (event.type === 'conversation.item.input_audio_transcription.delta') {
    updateDraft(event.item_id, event.delta || '');
    return;
  }

  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    finalizeSegmentFromEvent(event).catch((error) => {
      console.error('Segment finalization failed', error);
      showToast(error?.message || 'A segment failed to finalize.', 5000);
    });
    return;
  }

  if (event.type === 'transcripto.rollover.requested') {
    await rolloverConnection();
  }
}

async function rolloverConnection() {
  if (!state.currentSession || !state.client) return;
  showToast('Refreshing the live connection to keep the session healthy...');
  resetLiveCommitState();
  flushListeningClock();
  flushSpeechClock();
  await stopSpeakerTracking({ statusMessage: 'Refreshing speaker timing with the live connection...' });
  await state.client.disconnect({ nextStatus: 'reconnecting', message: 'Refreshing the live connection...' });
  state.client = null;
  await persistCurrentSessionNow();
  await startListening({ silent: true });
}

async function exportCurrentSession(kind) {
  if (!state.currentSession || !state.currentSegments.length) {
    showToast('There is nothing to export yet.');
    return;
  }
  if (kind === 'md') {
    exportSessionMarkdown(state.currentSession, state.currentSegments, buildTranscriptTimestamp);
  } else if (kind === 'txt') {
    exportSessionTxt(state.currentSession, state.currentSegments, buildTranscriptTimestamp);
  } else {
    exportSessionJson(state.currentSession, state.currentSegments);
  }
}

async function exportHistoricalSession(sessionId, kind) {
  const session = await getSession(sessionId);
  const segments = await listSegmentsBySession(sessionId);
  if (!session || !segments.length) {
    showToast('That session has no transcript segments to export.');
    return;
  }
  if (kind === 'md') {
    exportSessionMarkdown(session, segments, (segment) => buildTranscriptTimestamp(segment));
  } else if (kind === 'txt') {
    exportSessionTxt(session, segments, (segment) => buildTranscriptTimestamp(segment));
  } else {
    exportSessionJson(session, segments);
  }
}

async function applySpeakerAliasesToCurrentSession(nextAliases) {
  if (!state.currentSession) return;

  const cleanedAliases = Object.fromEntries(
    Object.entries(nextAliases || {})
      .map(([rawLabel, label]) => [String(rawLabel || '').trim(), String(label || '').trim()])
      .filter(([rawLabel, label]) => rawLabel && label)
  );

  state.currentSession.speakerAliases = cleanedAliases;
  state.currentSession.updatedAt = nowIso();

  const updatedSegments = [];
  state.currentSegments = state.currentSegments.map((segment) => {
    const rawLabel = getSegmentRawSpeakerLabel(segment);
    if (!rawLabel) return segment;

    const nextLabel = resolveSpeakerLabel(rawLabel, state.currentSession, segment.speakerLabel || getDefaultSpeakerLabel(rawLabel));
    if (segment.speakerRawLabel === rawLabel && segment.speakerLabel === nextLabel) {
      return segment;
    }

    const updatedSegment = {
      ...segment,
      speakerRawLabel: rawLabel,
      speakerLabel: nextLabel,
      speakerUpdatedAt: nowIso(),
    };
    updatedSegments.push(updatedSegment);
    return updatedSegment;
  });

  for (const segment of updatedSegments) {
    await upsertSegment(segment);
  }

  await persistCurrentSessionNow();
  renderCurrentView();
}

async function renameCurrentSession() {
  if (!state.currentSession) return;
  const nextTitle = window.prompt('Rename session', state.currentSession.title);
  if (!nextTitle || !nextTitle.trim()) return;
  state.currentSession.title = nextTitle.trim();
  await persistCurrentSessionNow();
  await refreshSessions();
  renderCurrentView();
}

async function renameSpeakerForCurrentSession(rawLabel) {
  if (!state.currentSession || !rawLabel) return;

  const defaultLabel = getDefaultSpeakerLabel(rawLabel);
  const sessionDefaultLabel = resolveSpeakerLabel(rawLabel, { speakerNames: state.currentSession.speakerNames }, defaultLabel);
  const currentLabel = resolveSpeakerLabel(rawLabel, state.currentSession, sessionDefaultLabel);
  const nextLabel = window.prompt(
    `Rename ${defaultLabel}. Leave blank to reset it back to the session default label.`,
    currentLabel === sessionDefaultLabel ? '' : currentLabel
  );

  if (nextLabel === null) return;

  const aliases = { ...(state.currentSession.speakerAliases || {}) };
  const trimmedLabel = nextLabel.trim();
  if (trimmedLabel) {
    aliases[rawLabel] = trimmedLabel;
  } else {
    delete aliases[rawLabel];
  }

  await applySpeakerAliasesToCurrentSession(aliases);
  showToast(trimmedLabel ? `${defaultLabel} renamed.` : `${defaultLabel} reset.`);
}

async function renameHistoricalSession(sessionId) {
  const session = await getSession(sessionId);
  if (!session) return;
  const nextTitle = window.prompt('Rename session', session.title);
  if (!nextTitle || !nextTitle.trim()) return;
  session.title = nextTitle.trim();
  session.updatedAt = nowIso();
  await upsertSession(session);
  if (state.currentSession?.id === session.id) {
    state.currentSession.title = session.title;
  }
  await refreshSessions();
  renderCurrentView();
}

async function deleteHistoricalSession(sessionId) {
  const session = await getSession(sessionId);
  if (!session) return;
  const confirmed = window.confirm(`Delete local session "${session.title}"? This removes it from this browser only.`);
  if (!confirmed) return;
  await deleteSession(sessionId);
  if (state.currentSession?.id === sessionId) {
    state.currentSession = null;
    state.currentSegments = [];
    setStatus('idle', 'Waiting to start.');
  }
  if (state.lastActiveSessionId === sessionId) {
    await deleteMeta('lastActiveSessionId');
    state.lastActiveSessionId = null;
  }
  await refreshSessions();
  renderCurrentView();
  showToast('Local session deleted.');
}

async function openHistoricalSession(sessionId) {
  const session = await loadSession(sessionId);
  if (!session) {
    showToast('Session not found.');
    return;
  }
  setRoute('live');
  if (session.status !== 'ended') {
    await syncLastActiveSession();
  }
}

async function resumeLastSession() {
  if (!state.lastActiveSessionId) {
    showToast('There is no resumable session right now.');
    return;
  }
  const session = await loadSession(state.lastActiveSessionId);
  if (!session) {
    showToast('The last active session could not be found.');
    return;
  }
  setRoute('live');
  if (session.status !== 'ended') {
    await startListening();
  }
}

async function saveSettingsFromSettingsForm(event) {
  event.preventDefault();
  const values = collectSettingsFromSettingsForm();
  await persistSettings(values);

  let speakerNamesChanged = false;
  if (state.currentSession) {
    const previousSpeakerNames = normalizeSpeakerNamesInput(state.currentSession.speakerNames || '');
    state.currentSession.sourceLanguage = values.sourceLanguage;
    state.currentSession.targetLanguage = values.targetLanguage;
    state.currentSession.glossary = values.glossary;
    state.currentSession.speakerNames = values.speakerNames;
    state.currentSession.updatedAt = nowIso();
    speakerNamesChanged = previousSpeakerNames !== values.speakerNames;

    if (speakerNamesChanged) {
      await applySpeakerAliasesToCurrentSession(state.currentSession.speakerAliases || {});
    } else {
      await persistCurrentSessionNow();
    }
  }

  if (!speakerNamesChanged) {
    renderCurrentView();
  }
  showToast('Settings saved locally.');
}

async function forgetApiKey() {
  const confirmed = window.confirm('Forget the stored API key in this browser?');
  if (!confirmed) return;
  await persistSettings({ apiKey: '' });
  showToast('API key removed from local storage.');
}

async function clearRecoveryMarkers() {
  await deleteMeta('lastActiveSessionId');
  state.lastActiveSessionId = null;
  renderResumeButtons();
  showToast('Recovery marker cleared.');
}

function bindNavigation() {
  elements.menuButton.addEventListener('click', openSidebar);
  elements.sidebarClose.addEventListener('click', closeSidebar);
  elements.backdrop.addEventListener('click', closeSidebar);

  document.body.addEventListener('click', async (event) => {
    const navButton = event.target.closest('[data-route]');
    if (navButton) {
      setRoute(navButton.dataset.route);
      return;
    }

    const actionButton = event.target.closest('[data-action="new-session"]');
    if (actionButton) {
      await createFreshSessionFromLive();
      return;
    }
  });
}

function bindEvents() {
  bindNavigation();
  elements.startForm.addEventListener('submit', handleStartFromSetup);
  elements.settingsForm.addEventListener('submit', saveSettingsFromSettingsForm);

  elements.toggleApiKey.addEventListener('click', () => togglePasswordVisibility(elements.apiKeyInput, elements.toggleApiKey));
  elements.settingsToggleApiKey.addEventListener('click', () => togglePasswordVisibility(elements.settingsApiKeyInput, elements.settingsToggleApiKey));

  elements.resumeLastSessionButton.addEventListener('click', resumeLastSession);
  elements.recoverDraftButton.addEventListener('click', resumeLastSession);
  elements.openHistoryFromSetup.addEventListener('click', () => setRoute('history'));
  elements.refreshHistoryButton.addEventListener('click', refreshSessions);
  getTranscriptViewButtons().forEach((button) => {
    button.addEventListener('click', () => setTranscriptView(button.dataset.transcriptView));
  });
  elements.jumpToLiveButton?.addEventListener('click', () => scrollTranscriptToLive());
  elements.transcriptList.addEventListener('scroll', updateTranscriptAutoFollowState);

  elements.startButton.addEventListener('click', () => startListening());
  elements.pauseButton.addEventListener('click', pauseListening);
  elements.resumeButton.addEventListener('click', () => startListening());
  elements.stopButton.addEventListener('click', stopListening);
  elements.endSessionButton.addEventListener('click', endCurrentSession);
  elements.newSessionButton.addEventListener('click', createFreshSessionFromLive);
  elements.renameSessionButton.addEventListener('click', renameCurrentSession);
  elements.speakerSummary.addEventListener('click', async (event) => {
    const renameButton = event.target.closest('[data-speaker-action="rename"]');
    if (!renameButton) return;
    await renameSpeakerForCurrentSession(renameButton.dataset.speakerRawLabel);
  });

  elements.exportMarkdownButton.addEventListener('click', () => exportCurrentSession('md'));
  elements.exportTxtButton.addEventListener('click', () => exportCurrentSession('txt'));
  elements.exportJsonButton.addEventListener('click', () => exportCurrentSession('json'));
  elements.exportCurrentFromSide.addEventListener('click', () => exportCurrentSession('json'));

  elements.toggleAutoScrollButton.addEventListener('click', async () => {
    await persistSettings({ autoScroll: !state.settings.autoScroll });
    renderCurrentView();
  });

  elements.forgetApiKeyButton.addEventListener('click', forgetApiKey);
  elements.clearEndedSessionsButton.addEventListener('click', async () => {
    const deleted = await deleteEndedSessions();
    if (deleted === 0) {
      showToast('No ended sessions to delete.');
      return;
    }
    await refreshSessions();
    if (state.currentSession?.status === 'ended') {
      state.currentSession = null;
      state.currentSegments = [];
      setStatus('idle', 'Waiting to start.');
    }
    renderCurrentView();
    showToast(`Deleted ${deleted} ended session${deleted === 1 ? '' : 's'}.`);
  });

  elements.clearAllSessionsButton.addEventListener('click', async () => {
    const confirmed = window.confirm('Delete all local session history from this browser?');
    if (!confirmed) return;
    if (state.client) {
      await stopListening();
    }
    await clearAllSessions();
    state.currentSession = null;
    state.currentSegments = [];
    state.lastActiveSessionId = null;
    setStatus('idle', 'Waiting to start.');
    await refreshSessions();
    renderCurrentView();
    showToast('All local sessions deleted.');
  });

  elements.clearDraftsButton.addEventListener('click', clearRecoveryMarkers);

  elements.historyList.addEventListener('click', async (event) => {
    const actionEl = event.target.closest('[data-history-action]');
    if (!actionEl) return;
    const { historyAction, sessionId } = actionEl.dataset;
    if (historyAction === 'open') await openHistoricalSession(sessionId);
    if (historyAction === 'rename') await renameHistoricalSession(sessionId);
    if (historyAction === 'delete') await deleteHistoricalSession(sessionId);
    if (historyAction === 'export-md') await exportHistoricalSession(sessionId, 'md');
    if (historyAction === 'export-txt') await exportHistoricalSession(sessionId, 'txt');
    if (historyAction === 'export-json') await exportHistoricalSession(sessionId, 'json');
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    elements.installCard.classList.remove('hidden');
  });

  elements.installButton.addEventListener('click', async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice.catch(() => null);
    state.installPrompt = null;
    elements.installCard.classList.add('hidden');
  });

  window.addEventListener('pagehide', () => {
    flushListeningClock();
    flushSpeechClock();
    stopSpeakerTracking({ statusMessage: 'Leaving the page. Speaker timing is paused.' }).catch(() => {});
    if (state.currentSession && state.currentSession.status !== 'ended' && ['listening', 'connecting', 'reconnecting'].includes(state.runtimeStatus)) {
      state.currentSession.runtimeStatus = 'stopped';
      state.currentSession.status = 'paused';
    }
    persistCurrentSessionNow().catch(() => {});
  });
}

function togglePasswordVisibility(input, button) {
  const nextType = input.type === 'password' ? 'text' : 'password';
  input.type = nextType;
  button.textContent = nextType === 'password' ? 'Show' : 'Hide';
}

async function loadBootstrapData() {
  state.settings = {
    ...DEFAULT_SETTINGS,
    ...(await getSettings()),
  };
  state.lastActiveSessionId = await getMeta('lastActiveSessionId');
  await refreshSessions();
  applySettingsToForms();

  if (state.lastActiveSessionId) {
    const session = state.sessions.find((item) => item.id === state.lastActiveSessionId && item.status !== 'ended');
    if (session) {
      await loadSession(session.id);
    }
  }

  if (!state.currentSession) {
    setStatus('idle', 'Waiting to start.');
  }
}

function buildDebugSnapshot() {
  return {
    sourceDraft: elements.sourceDraftText?.textContent || '',
    sourceState: elements.sourceDraftState?.textContent || '',
    sourceCarry: elements.sourceDraftCarryText?.textContent || '',
    targetDraft: elements.targetDraftText?.textContent || '',
    targetState: elements.targetDraftState?.textContent || '',
    targetCarry: elements.targetDraftCarryText?.textContent || '',
    status: elements.statusLine?.textContent || '',
  };
}

async function ensureDebugSession({ sourceLanguage = 'en', targetLanguage = 'de' } = {}) {
  if (!state.currentSession || state.currentSession.status === 'ended') {
    const session = await createSession({
      sourceLanguage,
      targetLanguage,
      glossary: '',
      speakerNames: '',
    });
    state.currentSession = session;
    state.currentSegments = [];
    clearLiveDraftCarry();
  }

  state.currentSession.status = 'active';
  state.currentSession.runtimeStatus = 'listening';
  setStatus('listening', 'Debug replay active.');
  setRoute('live');
  renderCurrentView();
  return buildDebugSnapshot();
}

function setDebugDraftTranslation(itemId, translatedText = '') {
  const draftState = state.draftByItemId.get(itemId) || { sourceDraft: '', translatedDraft: '' };
  draftState.translatedDraft = String(translatedText || '').trim();
  state.draftByItemId.set(itemId, draftState);
  if (state.activeDraftItemId === itemId && state.currentSession) {
    state.currentSession.draftTranslation = draftState.translatedDraft;
  }
  renderDrafts();
  return buildDebugSnapshot();
}

async function runDebugReplaySteps(steps = []) {
  for (const step of steps) {
    if (!step) continue;
    if (step.kind === 'translation') {
      setDebugDraftTranslation(step.itemId, step.text);
      continue;
    }
    if (step.kind === 'snapshot') {
      renderCurrentView();
      continue;
    }
    if (step.kind === 'event' && step.event) {
      await handleRealtimeEvent(step.event);
    }
  }
  renderCurrentView();
  return buildDebugSnapshot();
}

function buildMay05DemoReplaySteps() {
  return [
    { kind: 'event', event: { type: 'input_audio_buffer.speech_started' } },
    { kind: 'event', event: { type: 'input_audio_buffer.committed', item_id: 'may05-1', previous_item_id: null } },
    {
      kind: 'event',
      event: {
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'may05-1',
        delta: 'So it is listening now, and let us see if it can capture.',
      },
    },
    {
      kind: 'translation',
      itemId: 'may05-1',
      text: 'Es hört jetzt zu, und schauen wir mal, ob es das erfassen kann.',
    },
    { kind: 'event', event: { type: 'input_audio_buffer.committed', item_id: 'may05-2', previous_item_id: 'may05-1' } },
    {
      kind: 'event',
      event: {
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'may05-2',
        delta: 'And you look at this, it does not really work. It goes too fast.',
      },
    },
    {
      kind: 'translation',
      itemId: 'may05-2',
      text: 'Und wenn du dir das anschaust, es funktioniert nicht wirklich. Es geht zu schnell.',
    },
    { kind: 'event', event: { type: 'input_audio_buffer.committed', item_id: 'may05-3', previous_item_id: 'may05-2' } },
    {
      kind: 'event',
      event: {
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'may05-3',
        delta: 'I cannot even see the German translation. It is constantly changing.',
      },
    },
    {
      kind: 'translation',
      itemId: 'may05-3',
      text: 'Ich kann nicht einmal die deutsche Übersetzung sehen. Sie ändert sich ständig.',
    },
    { kind: 'event', event: { type: 'input_audio_buffer.committed', item_id: 'may05-4', previous_item_id: 'may05-3' } },
    {
      kind: 'event',
      event: {
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'may05-4',
        delta: 'And even the audio buffer issue is coming up again.',
      },
    },
  ];
}

function installDebugHooks() {
  if (typeof window === 'undefined') return;
  const debugAllowed =
    ['127.0.0.1', 'localhost'].includes(window.location.hostname) || window.location.search.includes('debug-live=1');
  if (!debugAllowed) return;

  window.__transcriptoDebug = {
    ensureSession: ensureDebugSession,
    snapshot: buildDebugSnapshot,
    setDraftTranslation: setDebugDraftTranslation,
    clearCarry: () => {
      clearLiveDraftCarry();
      renderDrafts();
      return buildDebugSnapshot();
    },
    replay: runDebugReplaySteps,
    replayMay05Demo: async () => {
      await ensureDebugSession({ sourceLanguage: 'en', targetLanguage: 'de' });
      return runDebugReplaySteps(buildMay05DemoReplaySteps());
    },
    shouldCommitLiveDraftText,
  };
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    registration.update().catch(() => {});
  } catch (error) {
    console.warn('Service worker registration failed', error);
  }
}

async function init() {
  fillLanguageSelect(elements.sourceLanguageInput);
  fillLanguageSelect(elements.targetLanguageInput);
  fillLanguageSelect(elements.settingsSourceLanguage);
  fillLanguageSelect(elements.settingsTargetLanguage);
  bindEvents();
  renderCurrentView();
  installDebugHooks();
  await loadBootstrapData();
  renderCurrentView();
  startClockTimer();
  await registerServiceWorker();
}

init().catch((error) => {
  console.error(error);
  showToast(error?.message || 'Transcripto failed to load.', 6000);
});
