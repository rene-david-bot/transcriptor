import {
  clearAllSessions,
  countSegments,
  deleteMeta,
  deleteSession,
  deleteEndedSessions,
  getMeta,
  listRecordingsBySession,
  getSession,
  getSettings,
  getStorageSummary,
  listSegmentsBySession,
  listSessions,
  saveSettings,
  setMeta,
  upsertRecording,
  upsertSegment,
  upsertSession,
} from './db.js';
import { exportSessionJson, exportSessionMarkdown, exportSessionTxt } from './exporters.js';
import {
  buildRealtimeTranscriptionSessionPreview,
  diarizeAudioChunk,
  RealtimeTranscriptionClient,
  translateText,
} from './openai.js';

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
  realtimeTranscriptionModel: 'gpt-4o-mini-transcribe',
  glossary: '',
  speakerNames: '',
  microphoneDeviceId: '',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  theme: 'dark',
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
const DISPLAY_ROW_TARGET_MS = 7000;
const DISPLAY_ROW_MAX_MS = 10000;
const DISPLAY_ROW_MAX_GAP_MS = 1800;
const DISPLAY_ROW_MAX_SENTENCE_COUNT = 2;
const TRANSCRIPT_FOLLOW_TRIGGER_RATIO = 0.72;
const TRANSCRIPT_FOLLOW_SLACK_PX = 72;
const SPEAKER_CHUNK_MS = 20000;
const SPEAKER_INITIAL_CHUNK_MS = 8000;
const SPEAKER_MIN_CHUNK_BYTES = 4000;
const SPEAKER_MATCH_MARGIN_MS = 3200;
const SESSION_RECORDING_CHUNK_MS = 60000;
const SPEAKER_FINALIZE_RETRY_DELAY_MS = 1200;
const SPEAKER_FINALIZE_MAX_ATTEMPTS = 2;
const SPEAKER_FINALIZE_BATCH_TARGET_MS = 5 * 60 * 1000;

const state = {
  route: 'setup',
  settings: { ...DEFAULT_SETTINGS },
  sessions: [],
  currentSession: null,
  currentSegments: [],
  client: null,
  runtimeStatus: 'idle',
  runtimeMessage: 'Waiting to start.',
  availableMicrophones: [],
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
  speakerChunkStopTimer: null,
  speakerChunkStartMs: 0,
  speakerChunkIndex: 0,
  speakerNextChunkDurationMs: SPEAKER_INITIAL_CHUNK_MS,
  speakerAttributionQueue: Promise.resolve(),
  speakerSpansBySession: new Map(),
  speakerTrackingInFlight: false,
  speakerTrackingPendingChunks: 0,
  speakerTrackingStopRequested: false,
  speakerTrackingSessionId: null,
  speakerTrackingStatus: 'Speaker detection is idle.',
  speakerFinalizeInProgress: false,
  speakerFinalizeProgress: null,
  debugDiarizeAudioChunk: null,
  speakerSummaryExpandedKeys: new Set(),
  sessionRecordingSupported: typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined',
  sessionRecorder: null,
  sessionRecordingStream: null,
  sessionRecordingMimeType: '',
  sessionRecordingChunkStartMs: 0,
  sessionRecordingSessionId: null,
  sessionRecordingPersistTasks: new Set(),
  sessionRecordings: [],
  sessionPlaybackClipIndex: -1,
  sessionPlaybackObjectUrl: '',
  sessionPlaybackSegmentId: '',
  sessionPlaybackAutoScroll: true,
  sessionPlaybackPreviewMs: null,
  reviewAudioFloatingActive: false,
  screenWakeLock: null,
  wakeLockSupported: typeof navigator !== 'undefined' && 'wakeLock' in navigator,
  wakeLockActive: false,
  wakeLockWanted: false,
  wakeLockMessage: '',
  manualSpeakerEvents: [],
  manualSpeakerOpenStartMs: null,
  manualSpeakerActiveLabel: '',
  manualSpeakerBaseOffsetMs: 0,
  manualSpeakerElapsedMs: 0,
  manualSpeakerPaused: true,
  manualSpeakerCurrentLabel: '',
  manualSpeakerPendingChangeAtMs: null,
  manualSpeakerCustomNameDraft: '',
  manualSpeakerEditingEventId: '',
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
  openMicSettingsButton: $('#openMicSettingsButton'),
  topbarEyebrow: $('#topbarEyebrow'),
  topbarTitle: $('#topbarTitle'),
  toast: $('#toast'),
  startForm: $('#startForm'),
  apiKeyInput: $('#apiKeyInput'),
  toggleApiKey: $('#toggleApiKey'),
  sourceLanguageInput: $('#sourceLanguageInput'),
  targetLanguageInput: $('#targetLanguageInput'),
  realtimeTranscriptionModelInput: $('#realtimeTranscriptionModelInput'),
  micDeviceInput: $('#micDeviceInput'),
  refreshMicDevicesButton: $('#refreshMicDevicesButton'),
  echoCancellationInput: $('#echoCancellationInput'),
  noiseSuppressionInput: $('#noiseSuppressionInput'),
  autoGainControlInput: $('#autoGainControlInput'),
  glossaryInput: $('#glossaryInput'),
  speakerNamesInput: $('#speakerNamesInput'),
  resumeLastSessionButton: $('#resumeLastSessionButton'),
  recoverDraftButton: $('#recoverDraftButton'),
  openHistoryFromSetup: $('#openHistoryFromSetup'),
  sessionTitle: $('#sessionTitle'),
  sessionMeta: $('#sessionMeta'),
  durationValue: $('#durationValue'),
  speechOnlyValue: $('#speechOnlyValue'),
  segmentCountLabel: $('#segmentCountLabel'),
  segmentCountValue: $('#segmentCountValue'),
  segmentCountMeta: $('#segmentCountMeta'),
  startButton: $('#startButton'),
  pauseButton: $('#pauseButton'),
  resumeButton: $('#resumeButton'),
  stopButton: $('#stopButton'),
  newSessionButton: $('#newSessionButton'),
  endSessionButton: $('#endSessionButton'),
  transcriptBoard: $('#transcriptBoard'),
  transcriptLanguageChip: $('#transcriptLanguageChip'),
  transcriptViewSourceButton: $('#transcriptViewSource'),
  transcriptViewBothButton: $('#transcriptViewBoth'),
  transcriptViewTargetButton: $('#transcriptViewTarget'),
  transcriptModeNote: $('#transcriptModeNote'),
  transcriptSourceHeading: $('#transcriptSourceHeading'),
  transcriptTargetHeading: $('#transcriptTargetHeading'),
  transcriptLiveState: $('#transcriptLiveState'),
  jumpToLiveButton: $('#jumpToLiveButton'),
  transcriptHistoryDetails: $('#transcriptHistoryDetails'),
  transcriptHistoryMeta: $('#transcriptHistoryMeta'),
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
  finalizeSpeakerButton: $('#finalizeSpeakerButton'),
  speakerSummary: $('#speakerSummary'),
  transcriptList: $('#transcriptList'),
  reviewAudio: $('#reviewAudio'),
  reviewAudioTransportDock: $('#reviewAudioTransportDock'),
  reviewAudioTransport: $('#reviewAudioTransport'),
  reviewAudioStatus: $('#reviewAudioStatus'),
  reviewPlayPauseButton: $('#reviewPlayPauseButton'),
  reviewStopButton: $('#reviewStopButton'),
  reviewProgressInput: $('#reviewProgressInput'),
  reviewCurrentTime: $('#reviewCurrentTime'),
  reviewTotalTime: $('#reviewTotalTime'),
  reviewJumpBack5mButton: $('#reviewJumpBack5mButton'),
  reviewJumpBack30Button: $('#reviewJumpBack30Button'),
  reviewJumpForward30Button: $('#reviewJumpForward30Button'),
  reviewJumpForward5mButton: $('#reviewJumpForward5mButton'),
  speakerChangeDock: $('#speakerChangeDock'),
  speakerChangeTimer: $('#speakerChangeTimer'),
  speakerChangeTimerState: $('#speakerChangeTimerState'),
  speakerChangeCurrentLabel: $('#speakerChangeCurrentLabel'),
  speakerChangePendingHint: $('#speakerChangePendingHint'),
  speakerChangeButton: $('#speakerChangeButton'),
  speakerChangePauseButton: $('#speakerChangePauseButton'),
  speakerChangeResetButton: $('#speakerChangeResetButton'),
  speakerChangeCurrentSelect: $('#speakerChangeCurrentSelect'),
  speakerChangeCustomInput: $('#speakerChangeCustomInput'),
  speakerChangeCustomUseButton: $('#speakerChangeCustomUseButton'),
  speakerChangeMarkers: $('#speakerChangeMarkers'),
  transcriptLiveBand: $('#transcriptLiveBand'),
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
  settingsRealtimeTranscriptionModelInput: $('#settingsRealtimeTranscriptionModelInput'),
  settingsMicDeviceInput: $('#settingsMicDeviceInput'),
  settingsRefreshMicDevicesButton: $('#settingsRefreshMicDevicesButton'),
  settingsEchoCancellationInput: $('#settingsEchoCancellationInput'),
  settingsNoiseSuppressionInput: $('#settingsNoiseSuppressionInput'),
  settingsAutoGainControlInput: $('#settingsAutoGainControlInput'),
  textSizeSelect: $('#textSizeSelect'),
  themeSelect: $('#themeSelect'),
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
const REALTIME_TRANSCRIPTION_MODELS = [
  {
    value: 'gpt-4o-mini-transcribe',
    label: 'Balanced default, gpt-4o-mini-transcribe',
  },
  {
    value: 'gpt-realtime-whisper',
    label: 'Low-latency test, gpt-realtime-whisper',
  },
];
let debugNoPersistence = false;

function nowIso() {
  return new Date().toISOString();
}

function getLanguageName(code) {
  return LANGUAGE_MAP.get(code) || String(code || '').toUpperCase();
}

function formatLanguageCode(code) {
  return String(code || '').trim().toLowerCase();
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

function formatDurationShort(ms = 0) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${pad(minutes)}:${pad(seconds)}`;
}

function formatManualStopwatchTime(ms = 0) {
  const totalCentiseconds = Math.max(0, Math.floor(ms / 10));
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const seconds = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;

  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
  }

  return `${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
}

function wait(ms = 0) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function trackPendingSessionRecordingWrite(task) {
  if (!task || typeof task.finally !== 'function') return task;
  state.sessionRecordingPersistTasks.add(task);
  task.finally(() => {
    state.sessionRecordingPersistTasks.delete(task);
  });
  return task;
}

async function waitForPendingSessionRecordingWrites() {
  while (state.sessionRecordingPersistTasks.size) {
    const pending = [...state.sessionRecordingPersistTasks];
    await Promise.allSettled(pending);
  }
}

function getManualSpeakerEntryId(entry, index = 0) {
  return String(entry?.id || `manual-speaker-${index}-${Number(entry?.startMs ?? entry?.atMs ?? 0)}`);
}

function normalizeManualSpeakerSegments(entries = [], session = state.currentSession) {
  if (!Array.isArray(entries) || !entries.length) return [];

  const hasSegmentShape = entries.some(
    (entry) => entry && (Object.prototype.hasOwnProperty.call(entry, 'startMs') || Object.prototype.hasOwnProperty.call(entry, 'endMs'))
  );

  if (hasSegmentShape) {
    return entries
      .map((entry, index) => ({
        ...entry,
        id: getManualSpeakerEntryId(entry, index),
        speakerLabel: String(entry?.speakerLabel || '').trim(),
        startMs: Math.max(0, Number(entry?.startMs || 0)),
        endMs: Math.max(0, Number(entry?.endMs || entry?.startMs || 0)),
      }))
      .filter((entry) => entry.speakerLabel && entry.endMs > entry.startMs)
      .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  }

  const sessionDurationMs = getSessionRecordingDurationMs(
    session?.id && session?.id === state.currentSession?.id ? state.sessionRecordings : [],
    session
  );
  const legacyEvents = entries
    .map((entry, index) => ({
      ...entry,
      id: getManualSpeakerEntryId(entry, index),
      speakerLabel: String(entry?.speakerLabel || '').trim(),
      atMs: Math.max(0, Number(entry?.atMs || 0)),
    }))
    .filter((entry) => entry.speakerLabel)
    .sort((left, right) => left.atMs - right.atMs);

  return legacyEvents
    .map((entry, index) => {
      const nextEntry = legacyEvents[index + 1];
      const startMs = entry.atMs;
      const endMs = nextEntry ? nextEntry.atMs : sessionDurationMs;
      if (endMs <= startMs) return null;
      return {
        id: entry.id,
        speakerLabel: entry.speakerLabel,
        startMs,
        endMs,
      };
    })
    .filter(Boolean);
}

function getManualSpeakerEventsForSession(session = state.currentSession) {
  if (!session) return [];
  const rawEntries = session?.id && state.currentSession?.id === session.id
    ? state.manualSpeakerEvents
    : Array.isArray(session?.manualSpeakerEvents)
      ? session.manualSpeakerEvents
      : [];
  return normalizeManualSpeakerSegments(rawEntries, session);
}

function recordingTimeToLocalOffset(recording, absoluteMs) {
  return Math.max(0, (absoluteMs || 0) - Number(recording?.startMs || 0));
}

function getSessionRecordingDurationMs(recordings = state.sessionRecordings, session = state.currentSession) {
  const maxRecordingEndMs = recordings.reduce(
    (max, recording) => Math.max(max, Number(recording?.endMs || recording?.startMs || 0)),
    0
  );
  return Math.max(maxRecordingEndMs, Number(session?.activeDurationMs || 0));
}

function clampSessionPlaybackMs(absoluteMs, durationMs = getSessionRecordingDurationMs()) {
  return Math.max(0, Math.min(Math.round(Number(absoluteMs || 0)), Math.max(0, Number(durationMs || 0))));
}

function getVisibleSessionPlaybackMs() {
  if (state.sessionPlaybackPreviewMs !== null) {
    return clampSessionPlaybackMs(state.sessionPlaybackPreviewMs);
  }
  const absoluteMs = getCurrentPlaybackAbsoluteMs();
  return absoluteMs === null ? null : clampSessionPlaybackMs(absoluteMs);
}

function getManualSpeakerSessionPositionMs(session = state.currentSession) {
  if (!session) return 0;
  return session.status === 'active' ? getEffectiveActiveDuration() : Number(session.activeDurationMs || 0);
}

function getManualSpeakerElapsedMs() {
  if (state.manualSpeakerPaused) {
    return Math.max(0, Number(state.manualSpeakerElapsedMs || 0));
  }

  return Math.max(0, getManualSpeakerSessionPositionMs() - Number(state.manualSpeakerBaseOffsetMs || 0));
}

function isManualSpeakerTimerRunning() {
  return Boolean(state.currentSession && state.currentSession.status === 'active' && !state.manualSpeakerPaused);
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

function getTopbarEyebrowText() {
  if (state.runtimeStatus === 'listening') return 'Live capture';
  if (['connecting', 'reconnecting'].includes(state.runtimeStatus)) return 'Connecting';
  if (state.route === 'live') return 'Current session';
  if (state.route === 'history') return 'Session history';
  if (state.route === 'settings') return 'Settings';
  return 'Ready';
}

function getTopbarTitleText() {
  if (state.route === 'live') {
    const session = state.currentSession;
    if (session?.sourceLanguage || session?.targetLanguage) {
      return `${getLanguageName(session?.sourceLanguage || '')} → ${getLanguageName(session?.targetLanguage || '')}`;
    }
    return 'Live transcript';
  }
  if (state.route === 'history') return 'History';
  if (state.route === 'settings') return 'Preferences';
  return 'Transcripto';
}

function renderTopbarEyebrow() {
  if (!elements.topbarEyebrow) return;
  elements.topbarEyebrow.textContent = getTopbarEyebrowText();
}

function renderTopbarTitle() {
  if (!elements.topbarTitle) return;
  elements.topbarTitle.textContent = getTopbarTitleText();
}

function renderTopbarChrome() {
  renderTopbarEyebrow();
  renderTopbarTitle();
}

function syncReviewAudioTransportMount({ floatingPlayback = false } = {}) {
  const transport = elements.reviewAudioTransport;
  const dock = elements.reviewAudioTransportDock;
  if (!transport || !dock || typeof document === 'undefined' || !document.body) return;

  if (floatingPlayback) {
    if (transport.parentElement !== document.body) {
      document.body.appendChild(transport);
    }
    return;
  }

  if (transport.parentElement !== dock) {
    dock.appendChild(transport);
  }
}

function setReviewProgressVisual(absoluteMs, durationMs = getSessionRecordingDurationMs()) {
  const input = elements.reviewProgressInput;
  if (!input) return;
  const safeDuration = Math.max(0, Number(durationMs || 0));
  const safeAbsolute = Math.max(0, Number(absoluteMs || 0));
  const ratio = safeDuration > 0 ? Math.min(100, Math.max(0, (safeAbsolute / safeDuration) * 100)) : 0;
  input.style.setProperty('--range-progress', `${ratio}%`);
}

function setStatus(status, message) {
  state.runtimeStatus = status;
  state.runtimeMessage = message;
  elements.statusPill.textContent = STATUS_COPY[status] || status;
  elements.statusPill.className = `status-pill status-pill--${status}`;
  elements.statusLine.textContent = `Status: ${message}`;
  renderTopbarChrome();

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

function normalizeRealtimeTranscriptionModel(model) {
  const nextModel = String(model || '').trim();
  return REALTIME_TRANSCRIPTION_MODELS.some((option) => option.value === nextModel)
    ? nextModel
    : DEFAULT_SETTINGS.realtimeTranscriptionModel;
}

function populateRealtimeTranscriptionModelSelect(select, selectedModel = DEFAULT_SETTINGS.realtimeTranscriptionModel) {
  if (!select) return;

  select.innerHTML = REALTIME_TRANSCRIPTION_MODELS.map(
    (option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`
  ).join('');
  select.value = normalizeRealtimeTranscriptionModel(selectedModel);
}

function normalizeAudioProcessingEnabled(value, fallback = true) {
  return value === undefined ? fallback : Boolean(value);
}

function buildMicrophoneOptionLabel(device, index) {
  const label = String(device?.label || '').trim();
  if (label) return label;
  return index === 0 ? 'Default microphone' : `Microphone ${index}`;
}

function populateMicrophoneSelect(select, devices = [], selectedId = '') {
  if (!select) return;

  const options = [{ value: '', label: 'Default microphone' }];
  devices.forEach((device, index) => {
    options.push({
      value: String(device.deviceId || '').trim(),
      label: buildMicrophoneOptionLabel(device, index + 1),
    });
  });

  if (selectedId && !options.some((option) => option.value === selectedId)) {
    options.push({
      value: selectedId,
      label: 'Previously selected microphone (currently unavailable)',
    });
  }

  select.innerHTML = options
    .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join('');
  select.value = selectedId || '';
}

async function refreshMicrophoneOptions({ silent = false } = {}) {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices?.enumerateDevices) {
    state.availableMicrophones = [];
    populateMicrophoneSelect(elements.micDeviceInput, [], state.settings.microphoneDeviceId || '');
    populateMicrophoneSelect(elements.settingsMicDeviceInput, [], state.settings.microphoneDeviceId || '');
    return [];
  }

  try {
    const devices = await mediaDevices.enumerateDevices();
    state.availableMicrophones = devices
      .filter((device) => device.kind === 'audioinput')
      .map((device) => ({ deviceId: String(device.deviceId || '').trim(), label: String(device.label || '').trim() }));

    populateMicrophoneSelect(elements.micDeviceInput, state.availableMicrophones, state.settings.microphoneDeviceId || '');
    populateMicrophoneSelect(elements.settingsMicDeviceInput, state.availableMicrophones, state.settings.microphoneDeviceId || '');

    if (!silent) {
      showToast(
        state.availableMicrophones.some((device) => device.label)
          ? 'Microphone list refreshed.'
          : 'Microphone list refreshed. Device names may appear after microphone permission is granted.'
      );
    }

    return state.availableMicrophones;
  } catch (error) {
    console.warn('Unable to enumerate microphones', error);
    if (!silent) {
      showToast('Microphone devices could not be listed right now.', 4500);
    }
    return [];
  }
}

function applySettingsToForms() {
  const settings = state.settings;
  elements.apiKeyInput.value = settings.apiKey || '';
  elements.settingsApiKeyInput.value = settings.apiKey || '';
  elements.sourceLanguageInput.value = settings.sourceLanguage;
  elements.targetLanguageInput.value = settings.targetLanguage;
  elements.settingsSourceLanguage.value = settings.sourceLanguage;
  elements.settingsTargetLanguage.value = settings.targetLanguage;
  populateRealtimeTranscriptionModelSelect(
    elements.realtimeTranscriptionModelInput,
    normalizeRealtimeTranscriptionModel(settings.realtimeTranscriptionModel)
  );
  populateRealtimeTranscriptionModelSelect(
    elements.settingsRealtimeTranscriptionModelInput,
    normalizeRealtimeTranscriptionModel(settings.realtimeTranscriptionModel)
  );
  populateMicrophoneSelect(elements.micDeviceInput, state.availableMicrophones, settings.microphoneDeviceId || '');
  populateMicrophoneSelect(elements.settingsMicDeviceInput, state.availableMicrophones, settings.microphoneDeviceId || '');
  if (elements.echoCancellationInput) {
    elements.echoCancellationInput.checked = normalizeAudioProcessingEnabled(settings.echoCancellation);
  }
  if (elements.noiseSuppressionInput) {
    elements.noiseSuppressionInput.checked = normalizeAudioProcessingEnabled(settings.noiseSuppression);
  }
  if (elements.autoGainControlInput) {
    elements.autoGainControlInput.checked = normalizeAudioProcessingEnabled(settings.autoGainControl);
  }
  if (elements.settingsEchoCancellationInput) {
    elements.settingsEchoCancellationInput.checked = normalizeAudioProcessingEnabled(settings.echoCancellation);
  }
  if (elements.settingsNoiseSuppressionInput) {
    elements.settingsNoiseSuppressionInput.checked = normalizeAudioProcessingEnabled(settings.noiseSuppression);
  }
  if (elements.settingsAutoGainControlInput) {
    elements.settingsAutoGainControlInput.checked = normalizeAudioProcessingEnabled(settings.autoGainControl);
  }
  elements.glossaryInput.value = settings.glossary || '';
  elements.speakerNamesInput.value = settings.speakerNames || '';
  elements.settingsGlossaryInput.value = settings.glossary || '';
  elements.settingsSpeakerNamesInput.value = settings.speakerNames || '';
  elements.textSizeSelect.value = settings.textSize || 'medium';
  elements.themeSelect.value = normalizeTheme(settings.theme);
  elements.autoScrollInput.checked = Boolean(settings.autoScroll);
  elements.timestampStyleSelect.value = settings.timestampStyle || 'elapsed';
  elements.toggleAutoScrollButton.textContent = `Auto-follow: ${settings.autoScroll ? 'On' : 'Off'}`;
  applyTheme(settings.theme);
  document.body.classList.remove('text-size-small', 'text-size-medium', 'text-size-large', 'text-size-xlarge');
  document.body.classList.add(`text-size-${settings.textSize || 'medium'}`);
  elements.transcriptList.classList.remove('text-size-small', 'text-size-medium', 'text-size-large', 'text-size-xlarge');
  elements.transcriptList.classList.add(`text-size-${settings.textSize || 'medium'}`);
  if (elements.transcriptLiveBand) {
    elements.transcriptLiveBand.classList.remove('text-size-small', 'text-size-medium', 'text-size-large', 'text-size-xlarge');
    elements.transcriptLiveBand.classList.add(`text-size-${settings.textSize || 'medium'}`);
  }
  if (elements.transcriptSourceHeading) {
    elements.transcriptSourceHeading.textContent = getLanguageName(state.currentSession?.sourceLanguage || settings.sourceLanguage || '');
  }
  if (elements.transcriptTargetHeading) {
    elements.transcriptTargetHeading.textContent = getLanguageName(state.currentSession?.targetLanguage || settings.targetLanguage || '');
  }
  if (elements.transcriptLanguageChip) {
    const sourceCode = formatLanguageCode(state.currentSession?.sourceLanguage || settings.sourceLanguage || '');
    const targetCode = formatLanguageCode(state.currentSession?.targetLanguage || settings.targetLanguage || '');
    elements.transcriptLanguageChip.textContent = `${sourceCode || 'source'} ↔ ${targetCode || 'target'}`;
  }
  applyTranscriptViewButtonLabels();
  applyTranscriptView();
}

function getTranscriptViewButtons() {
  return $$('[data-transcript-view]');
}

function applyTranscriptViewButtonLabels() {
  const sourceLabel = getLanguageName(state.currentSession?.sourceLanguage || state.settings.sourceLanguage || 'source');
  const targetLabel = getLanguageName(state.currentSession?.targetLanguage || state.settings.targetLanguage || 'target');

  if (elements.transcriptViewSourceButton) {
    elements.transcriptViewSourceButton.textContent = sourceLabel;
    elements.transcriptViewSourceButton.setAttribute('aria-label', `Show ${sourceLabel} only`);
    elements.transcriptViewSourceButton.title = sourceLabel;
  }

  if (elements.transcriptViewBothButton) {
    elements.transcriptViewBothButton.textContent = 'Both';
    elements.transcriptViewBothButton.setAttribute('aria-label', `Show ${sourceLabel} and ${targetLabel}`);
    elements.transcriptViewBothButton.title = `${sourceLabel} + ${targetLabel}`;
  }

  if (elements.transcriptViewTargetButton) {
    elements.transcriptViewTargetButton.textContent = targetLabel;
    elements.transcriptViewTargetButton.setAttribute('aria-label', `Show ${targetLabel} only`);
    elements.transcriptViewTargetButton.title = targetLabel;
  }
}

function normalizeTheme(theme) {
  return theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme = state.settings?.theme) {
  const normalizedTheme = normalizeTheme(theme);
  document.body.dataset.theme = normalizedTheme;
  const metaThemeColor = document.getElementById('metaThemeColor');
  if (metaThemeColor) {
    metaThemeColor.setAttribute('content', normalizedTheme === 'light' ? '#f8fafc' : '#0b1020');
  }
}

function isCompactTranscriptLayout() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches;
}

function getTranscriptModeNote(mode = state.liveTranscriptView) {
  if (mode === 'source') {
    return 'A rolling reading window keeps the current source chunk steady while older history stays collapsed below.';
  }
  if (mode === 'target') {
    return 'A rolling reading window keeps the current translated chunk steady while older history stays collapsed below.';
  }
  return 'A rolling bilingual reading window keeps the active chunk steady while incoming text gathers below.';
}

function applyTranscriptView() {
  if (!elements.transcriptBoard) return;
  const buttons = getTranscriptViewButtons();
  const mode = buttons.length && TRANSCRIPT_VIEW_MODES.has(state.liveTranscriptView) ? state.liveTranscriptView : 'both';
  state.liveTranscriptView = mode;
  elements.transcriptBoard.classList.remove('transcript-board--source', 'transcript-board--both', 'transcript-board--target');
  elements.transcriptBoard.classList.add(`transcript-board--${mode}`);
  if (elements.transcriptModeNote) {
    elements.transcriptModeNote.textContent = getTranscriptModeNote(mode);
  }
  buttons.forEach((button) => {
    const active = button.dataset.transcriptView === mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function setTranscriptView(mode) {
  state.liveTranscriptView = TRANSCRIPT_VIEW_MODES.has(mode) ? mode : 'both';
  applyTranscriptView();
  renderTranscript();
}

function getTranscriptFollowAnchor(list = elements.transcriptList) {
  if (!list) return null;
  const pairs = list.querySelectorAll('.transcript-pair');
  return pairs[pairs.length - 1] || null;
}

function getTranscriptFollowTargetTop(list = elements.transcriptList) {
  if (!list) return 0;
  const anchor = getTranscriptFollowAnchor(list);
  if (!anchor) {
    return Math.max(0, list.scrollHeight - list.clientHeight);
  }
  const anchorBottom = anchor.offsetTop + anchor.offsetHeight;
  return Math.max(0, Math.round(anchorBottom - list.clientHeight * TRANSCRIPT_FOLLOW_TRIGGER_RATIO));
}

function getTranscriptFollowOverflow(list = elements.transcriptList) {
  if (!list || list.scrollHeight <= list.clientHeight + 24) return 0;
  const anchor = getTranscriptFollowAnchor(list);
  if (!anchor) return 0;
  const anchorBottom = anchor.offsetTop + anchor.offsetHeight;
  const followLine = list.scrollTop + list.clientHeight * TRANSCRIPT_FOLLOW_TRIGGER_RATIO;
  return anchorBottom - followLine;
}

function isTranscriptNearFollowPosition(slack = TRANSCRIPT_FOLLOW_SLACK_PX) {
  const list = elements.transcriptList;
  if (!list || list.scrollHeight <= list.clientHeight + 24) return true;
  return Math.max(0, list.scrollHeight - list.clientHeight - list.scrollTop) <= slack;
}

function updateTranscriptAutoFollowState() {
  state.transcriptPinnedToBottom = isTranscriptNearFollowPosition();
  if (elements.jumpToLiveButton) {
    elements.jumpToLiveButton.classList.toggle('hidden', state.transcriptPinnedToBottom || !state.currentSession);
  }
  if (elements.transcriptLiveState) {
    const liveState = buildLiveTranscriptState();
    elements.transcriptLiveState.textContent = liveState.liveStateLabel;
    elements.transcriptLiveState.title = liveState.liveMeta || liveState.liveStateLabel;
  }
}

function scrollTranscriptToLive(behavior = 'smooth') {
  const list = elements.transcriptList;
  if (!list) return;
  const targetTop = getTranscriptFollowTargetTop(list);
  if (behavior === 'smooth') {
    list.scrollTo({ top: targetTop, behavior: 'smooth' });
  } else {
    list.scrollTop = targetTop;
  }
  requestAnimationFrame(() => {
    state.transcriptPinnedToBottom = true;
    updateTranscriptAutoFollowState();
  });
}

async function persistSettings(partial = {}) {
  state.settings = {
    ...state.settings,
    ...partial,
  };
  if (!debugNoPersistence) {
    await saveSettings(state.settings);
  }
  applySettingsToForms();
}

function scheduleSessionPersist(delay = 250) {
  if (debugNoPersistence) return;
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
  if (debugNoPersistence) return;
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
    renderManualSpeakerControls();
    updatePlaybackHighlight();
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

function openMicrophoneSettings() {
  setRoute('settings');
  requestAnimationFrame(() => {
    elements.settingsMicDeviceInput?.focus();
  });
}

function setRoute(route) {
  state.route = route;
  document.body.dataset.route = route;
  $$('.page').forEach((page) => {
    page.classList.toggle('page--active', page.dataset.page === route);
  });
  renderTopbarChrome();
  closeSidebar();
}

function collectSettingsFromSetupForm() {
  return {
    apiKey: elements.apiKeyInput.value.trim(),
    sourceLanguage: elements.sourceLanguageInput.value,
    targetLanguage: elements.targetLanguageInput.value,
    realtimeTranscriptionModel: normalizeRealtimeTranscriptionModel(elements.realtimeTranscriptionModelInput?.value),
    microphoneDeviceId: elements.micDeviceInput?.value || '',
    echoCancellation: Boolean(elements.echoCancellationInput?.checked),
    noiseSuppression: Boolean(elements.noiseSuppressionInput?.checked),
    autoGainControl: Boolean(elements.autoGainControlInput?.checked),
    glossary: elements.glossaryInput.value.trim(),
    speakerNames: normalizeSpeakerNamesInput(elements.speakerNamesInput.value),
  };
}

function collectSettingsFromSettingsForm() {
  return {
    apiKey: elements.settingsApiKeyInput.value.trim(),
    sourceLanguage: elements.settingsSourceLanguage.value,
    targetLanguage: elements.settingsTargetLanguage.value,
    realtimeTranscriptionModel: normalizeRealtimeTranscriptionModel(elements.settingsRealtimeTranscriptionModelInput?.value),
    microphoneDeviceId: elements.settingsMicDeviceInput?.value || '',
    echoCancellation: Boolean(elements.settingsEchoCancellationInput?.checked),
    noiseSuppression: Boolean(elements.settingsNoiseSuppressionInput?.checked),
    autoGainControl: Boolean(elements.settingsAutoGainControlInput?.checked),
    glossary: elements.settingsGlossaryInput.value.trim(),
    speakerNames: normalizeSpeakerNamesInput(elements.settingsSpeakerNamesInput.value),
    textSize: elements.textSizeSelect.value,
    theme: normalizeTheme(elements.themeSelect.value),
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

function getSpeakerOptionsForManualControls(session = state.currentSession) {
  const seeded = getSpeakerNamesForContext(session);
  const fallback = ['Speaker A', 'Speaker B', 'Speaker C'];
  return [...new Set([...seeded, ...fallback])].filter(Boolean).slice(0, 8);
}

function normalizeManualSpeakerName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getResolvedManualSpeakerSelection(session = state.currentSession, { preferDom = true } = {}) {
  const domValue = preferDom ? normalizeManualSpeakerName(elements.speakerChangeCurrentSelect?.value || '') : '';
  const stateValue = normalizeManualSpeakerName(state.manualSpeakerCurrentLabel || session?.manualSpeakerCurrentLabel || '');
  const fallbackValue = getSpeakerOptionsForManualControls(session)[0] || 'Speaker A';
  const rawValue = domValue || stateValue || fallbackValue;
  return findExistingManualSpeakerOption(rawValue, session) || rawValue;
}

function syncManualSpeakerSelectionFromUi(session = state.currentSession) {
  const nextLabel = getResolvedManualSpeakerSelection(session);
  state.manualSpeakerCurrentLabel = nextLabel;
  if (session) {
    session.manualSpeakerCurrentLabel = nextLabel;
  }
  return nextLabel;
}

function setPendingManualSpeakerChangeAtCurrentPosition(session = state.currentSession) {
  if (!session || session.status !== 'active' || state.manualSpeakerPaused || state.manualSpeakerOpenStartMs === null) {
    state.manualSpeakerPendingChangeAtMs = null;
    if (session) {
      session.manualSpeakerPendingChangeAtMs = null;
    }
    return null;
  }

  const nextAtMs = Math.max(0, getManualSpeakerSessionPositionMs(session));
  state.manualSpeakerPendingChangeAtMs = nextAtMs;
  if (session) {
    session.manualSpeakerPendingChangeAtMs = nextAtMs;
  }
  return nextAtMs;
}

function clearPendingManualSpeakerChange(session = state.currentSession) {
  state.manualSpeakerPendingChangeAtMs = null;
  if (session) {
    session.manualSpeakerPendingChangeAtMs = null;
  }
}

function updatePendingManualSpeakerChangeForCurrentLabel(session = state.currentSession) {
  if (!session || session.status !== 'active' || state.manualSpeakerPaused || state.manualSpeakerOpenStartMs === null) {
    clearPendingManualSpeakerChange(session);
    return null;
  }

  const nextLabel = normalizeManualSpeakerName(state.manualSpeakerCurrentLabel || session?.manualSpeakerCurrentLabel || '');
  const activeLabel = normalizeManualSpeakerName(state.manualSpeakerActiveLabel || nextLabel);

  if (!nextLabel || nextLabel === activeLabel) {
    clearPendingManualSpeakerChange(session);
    return null;
  }

  return setPendingManualSpeakerChangeAtCurrentPosition(session);
}

function addManualSpeakerSegment(speakerLabel, startMs, endMs) {
  const normalizedLabel = normalizeManualSpeakerName(speakerLabel);
  const normalizedStartMs = Math.max(0, Math.round(Number(startMs || 0)));
  const normalizedEndMs = Math.max(normalizedStartMs, Math.round(Number(endMs || 0)));
  if (!normalizedLabel || normalizedEndMs <= normalizedStartMs) return false;

  state.manualSpeakerEvents = normalizeManualSpeakerSegments(
    [
      ...state.manualSpeakerEvents,
      {
        id: crypto.randomUUID(),
        speakerLabel: normalizedLabel,
        startMs: normalizedStartMs,
        endMs: normalizedEndMs,
      },
    ],
    state.currentSession
  );
  return true;
}

async function splitManualSpeakerSpan({ atMs = getManualSpeakerSessionPositionMs(), persist = true } = {}) {
  if (!state.currentSession || state.currentSession.status !== 'active' || state.manualSpeakerOpenStartMs === null) {
    clearPendingManualSpeakerChange();
    return false;
  }

  const absoluteAtMs = Math.max(0, Math.round(Number(atMs || 0)));
  const nextLabel = syncManualSpeakerSelectionFromUi();
  const activeLabel = normalizeManualSpeakerName(state.manualSpeakerActiveLabel || nextLabel);
  const openStartMs = Math.max(0, Number(state.manualSpeakerOpenStartMs || 0));
  const rawSplitAtMs = state.manualSpeakerPendingChangeAtMs === null ? absoluteAtMs : state.manualSpeakerPendingChangeAtMs;
  const splitAtMs = Math.max(openStartMs, Math.min(absoluteAtMs, Math.round(Number(rawSplitAtMs || absoluteAtMs))));

  const didAddSegment = addManualSpeakerSegment(activeLabel, openStartMs, splitAtMs);
  state.manualSpeakerOpenStartMs = splitAtMs;
  state.manualSpeakerActiveLabel = normalizeManualSpeakerName(nextLabel || activeLabel);
  clearPendingManualSpeakerChange();
  syncManualSpeakerStateToSession();

  await applyManualSpeakerEventsToCurrentSession();
  if (persist) {
    await persistManualSpeakerStateNow();
  }
  renderManualSpeakerControls();
  return didAddSegment;
}

async function commitCurrentManualSpeakerSpan({ atMs = getManualSpeakerSessionPositionMs(), persist = true } = {}) {
  if (!state.currentSession || state.manualSpeakerOpenStartMs === null) {
    clearPendingManualSpeakerChange();
    return false;
  }

  const stopAtMs = Math.max(0, Math.round(Number(atMs || 0)));
  const selectedLabel = syncManualSpeakerSelectionFromUi();
  let activeLabel = normalizeManualSpeakerName(state.manualSpeakerActiveLabel || selectedLabel);
  let openStartMs = Math.max(0, Number(state.manualSpeakerOpenStartMs || 0));
  let changed = false;

  if (
    state.manualSpeakerPendingChangeAtMs !== null &&
    selectedLabel &&
    activeLabel &&
    normalizeManualSpeakerName(selectedLabel) !== activeLabel
  ) {
    const splitAtMs = Math.max(openStartMs, Math.min(stopAtMs, Math.round(Number(state.manualSpeakerPendingChangeAtMs || stopAtMs))));
    changed = addManualSpeakerSegment(activeLabel, openStartMs, splitAtMs) || changed;
    openStartMs = splitAtMs;
    activeLabel = normalizeManualSpeakerName(selectedLabel);
  }

  changed = addManualSpeakerSegment(activeLabel, openStartMs, stopAtMs) || changed;
  state.manualSpeakerOpenStartMs = null;
  state.manualSpeakerActiveLabel = '';
  clearPendingManualSpeakerChange();
  syncManualSpeakerStateToSession();

  await applyManualSpeakerEventsToCurrentSession();
  if (persist) {
    await persistManualSpeakerStateNow();
  }
  renderManualSpeakerControls();
  return changed;
}

function findExistingManualSpeakerOption(value, session = state.currentSession) {
  const normalizedValue = normalizeManualSpeakerName(value).toLocaleLowerCase();
  if (!normalizedValue) return '';
  return (
    getSpeakerOptionsForManualControls(session).find(
      (label) => normalizeManualSpeakerName(label).toLocaleLowerCase() === normalizedValue
    ) || ''
  );
}

async function useManualSpeakerCustomName(rawValue = state.manualSpeakerCustomNameDraft) {
  const nextLabel = normalizeManualSpeakerName(rawValue);
  if (!nextLabel) {
    showToast('Type a speaker name first.');
    elements.speakerChangeCustomInput?.focus();
    return false;
  }

  const existingLabel = findExistingManualSpeakerOption(nextLabel);
  const resolvedLabel = existingLabel || nextLabel;

  if (state.currentSession) {
    const currentSpeakerNames = parseSpeakerNames(state.currentSession.speakerNames || '');
    const hasSeededName = currentSpeakerNames.some(
      (label) => normalizeManualSpeakerName(label).toLocaleLowerCase() === resolvedLabel.toLocaleLowerCase()
    );

    if (!existingLabel && !hasSeededName) {
      if (currentSpeakerNames.length >= 8) {
        showToast('This session already has 8 speaker names. Reuse one or edit the saved list first.', 4500);
        return false;
      }
      state.currentSession.speakerNames = normalizeSpeakerNamesInput([...currentSpeakerNames, resolvedLabel].join(', '));
    }
  }

  state.manualSpeakerCurrentLabel = resolvedLabel;
  state.manualSpeakerCustomNameDraft = '';

  if (state.currentSession?.status === 'active' && !state.manualSpeakerPaused) {
    updatePendingManualSpeakerChangeForCurrentLabel();
  } else {
    clearPendingManualSpeakerChange();
  }

  if (state.currentSession) {
    syncManualSpeakerStateToSession();
    renderManualSpeakerControls();
    await persistCurrentSessionNow();
  }

  showToast(existingLabel ? `${resolvedLabel} selected.` : `${resolvedLabel} added for this session.`);
  return true;
}

async function applyManualSpeakerSelectionFromControl() {
  const nextLabel = normalizeManualSpeakerName(elements.speakerChangeCurrentSelect?.value || '');
  if (!nextLabel) return false;

  const previousLabel = normalizeManualSpeakerName(state.manualSpeakerCurrentLabel || state.currentSession?.manualSpeakerCurrentLabel || '');
  const previousPendingAtMs = state.manualSpeakerPendingChangeAtMs;
  const resolvedLabel = findExistingManualSpeakerOption(nextLabel, state.currentSession) || nextLabel;

  state.manualSpeakerCurrentLabel = resolvedLabel;
  state.manualSpeakerCustomNameDraft = '';

  if (state.currentSession) {
    state.currentSession.manualSpeakerCurrentLabel = resolvedLabel;
  }

  if (state.currentSession?.status === 'active' && !state.manualSpeakerPaused) {
    updatePendingManualSpeakerChangeForCurrentLabel();
  } else {
    clearPendingManualSpeakerChange();
  }

  renderManualSpeakerControls();

  if (state.currentSession) {
    syncManualSpeakerStateToSession();
    if (resolvedLabel !== previousLabel || state.manualSpeakerPendingChangeAtMs !== previousPendingAtMs) {
      await persistCurrentSessionNow();
    }
  }

  return true;
}

function getManualSpeakerLabelForSegment(segment, session = state.currentSession) {
  const segments = getManualSpeakerEventsForSession(session);
  if (!segment) return '';
  const segmentStartMs = Number(segment.startMs || 0);

  for (const manualSegment of segments) {
    if (segmentStartMs >= Number(manualSegment.startMs || 0) && segmentStartMs < Number(manualSegment.endMs || 0)) {
      return String(manualSegment.speakerLabel || '').trim();
    }
  }

  if (
    session?.id !== state.currentSession?.id ||
    !state.currentSession ||
    state.currentSession.status !== 'active' ||
    state.manualSpeakerPaused ||
    state.manualSpeakerOpenStartMs === null
  ) {
    return '';
  }

  const currentPositionMs = Math.max(0, getManualSpeakerSessionPositionMs(session));
  const openStartMs = Math.max(0, Number(state.manualSpeakerOpenStartMs || 0));
  const selectedLabel = normalizeManualSpeakerName(state.manualSpeakerCurrentLabel || '');
  const activeLabel = normalizeManualSpeakerName(state.manualSpeakerActiveLabel || selectedLabel);

  if (
    state.manualSpeakerPendingChangeAtMs !== null &&
    selectedLabel &&
    activeLabel &&
    selectedLabel !== activeLabel
  ) {
    const splitAtMs = Math.max(openStartMs, Math.min(currentPositionMs, Math.round(Number(state.manualSpeakerPendingChangeAtMs || currentPositionMs))));
    if (segmentStartMs >= openStartMs && segmentStartMs < splitAtMs) {
      return activeLabel;
    }
    if (segmentStartMs >= splitAtMs && segmentStartMs < currentPositionMs) {
      return selectedLabel;
    }
    return '';
  }

  return segmentStartMs >= openStartMs && segmentStartMs < currentPositionMs ? activeLabel : '';
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
    const label = getTranscriptSpeakerLabel(segment) || getDefaultSpeakerLabel(rawLabel);
    if (!label) continue;
    const segmentStartMs = Number(segment.startMs ?? segment.endMs ?? 0);
    const segmentEndMs = Number(segment.endMs ?? segment.startMs ?? 0);
    const key = getSpeakerSummaryKey(rawLabel, label);
    const current = summaryMap.get(key) || {
      key,
      label,
      rawLabel,
      defaultLabel: getDefaultSpeakerLabel(rawLabel),
      durationMs: 0,
      segments: 0,
      startMs: null,
      endMs: null,
    };
    current.durationMs += Math.max(1000, segment.speakerDurationMs || segment.endMs - segment.startMs || 0);
    current.segments += 1;
    current.startMs = current.startMs === null ? segmentStartMs : Math.min(current.startMs, segmentStartMs);
    current.endMs = current.endMs === null ? segmentEndMs : Math.max(current.endMs, segmentEndMs);
    summaryMap.set(key, current);
  }

  const slotRollup = buildManualSpeakerSlotRollup(state.currentSession, segments);
  slotRollup.speakers.forEach((speaker) => {
    const key = getSpeakerSummaryKeyForManualLabel(speaker.label, state.currentSession);
    const current = summaryMap.get(key) || {
      key,
      label: speaker.label,
      rawLabel: '',
      defaultLabel: speaker.label,
      durationMs: 0,
      segments: 0,
      startMs: speaker.slots[0]?.startMs ?? null,
      endMs: speaker.slots[speaker.slots.length - 1]?.endMs ?? null,
    };
    current.slotCount = speaker.slotCount;
    current.slotSpeechMs = speaker.speechMs;
    current.slotWindowMs = speaker.windowMs;
    current.slots = speaker.slots;
    summaryMap.set(key, current);
  });

  return Array.from(summaryMap.values()).sort(
    (a, b) => Math.max(b.slotSpeechMs || 0, b.durationMs || 0) - Math.max(a.slotSpeechMs || 0, a.durationMs || 0) || a.label.localeCompare(b.label)
  );
}

function buildManualSpeakerSlots(session = state.currentSession, segments = state.currentSegments) {
  if (!session) return [];
  const sessionEvents = getManualSpeakerEventsForSession(session);
  const slotSegments = [...sessionEvents]
    .map((event, index) => ({
      ...event,
      id: getManualSpeakerEntryId(event, index),
      speakerLabel: String(event.speakerLabel || '').trim(),
      startMs: Math.max(0, Number(event.startMs || 0)),
      endMs: Math.max(0, Number(event.endMs || event.startMs || 0)),
    }))
    .filter((event) => event.speakerLabel && event.endMs > event.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

  if (!slotSegments.length) return [];

  return slotSegments
    .map((event) => {
      const startMs = Math.max(0, Number(event.startMs || 0));
      const endMs = Math.max(startMs, Number(event.endMs || startMs));

      const overlappingSegments = segments.filter(
        (segment) => overlapMs(startMs, endMs, Number(segment.startMs || 0), Number(segment.speechEndMs || segment.endMs || segment.startMs || 0)) > 0
      );

      const rawSpeakerDurations = overlappingSegments.reduce((accumulator, segment) => {
        const rawSpeaker = String(segment.speakerRawLabel || '').trim();
        if (!rawSpeaker) return accumulator;
        const sharedMs = overlapMs(startMs, endMs, Number(segment.startMs || 0), Number(segment.speechEndMs || segment.endMs || segment.startMs || 0));
        accumulator[rawSpeaker] = (accumulator[rawSpeaker] || 0) + sharedMs;
        return accumulator;
      }, {});

      return {
        id: event.id,
        label: event.speakerLabel,
        startMs,
        endMs,
        windowMs: Math.max(0, endMs - startMs),
        speechMs: overlappingSegments.reduce(
          (total, segment) => total + overlapMs(startMs, endMs, Number(segment.startMs || 0), Number(segment.speechEndMs || segment.endMs || segment.startMs || 0)),
          0
        ),
        segmentCount: overlappingSegments.length,
        rawSpeakerDurations,
      };
    })
    .filter(Boolean);
}

function buildManualSpeakerSlotRollup(session = state.currentSession, segments = state.currentSegments) {
  const slots = buildManualSpeakerSlots(session, segments);
  const speakerMap = new Map();

  slots.forEach((slot) => {
    const key = getSpeakerSummaryKeyForManualLabel(slot.label || 'Speaker', session);
    const current = speakerMap.get(key) || {
      key,
      label: slot.label || 'Speaker',
      speechMs: 0,
      windowMs: 0,
      slotCount: 0,
      slots: [],
    };
    current.speechMs += Math.max(0, Number(slot.speechMs || 0));
    current.windowMs += Math.max(0, Number(slot.windowMs || 0));
    current.slotCount += 1;
    current.slots.push(slot);
    speakerMap.set(key, current);
  });

  return {
    slots,
    totalSpeechMs: slots.reduce((total, slot) => total + Math.max(0, Number(slot.speechMs || 0)), 0),
    totalWindowMs: slots.reduce((total, slot) => total + Math.max(0, Number(slot.windowMs || 0)), 0),
    speakers: Array.from(speakerMap.values()).sort((left, right) => right.speechMs - left.speechMs || left.label.localeCompare(right.label)),
  };
}

function buildManualLabelToCanonicalRawMap(session = state.currentSession) {
  const map = new Map();
  parseSpeakerNames(session?.speakerNames || state.settings.speakerNames || '').forEach((name, index) => {
    map.set(normalizeTranscriptSpeakerKey(name), String.fromCharCode(65 + index));
  });
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((rawLabel) => {
    map.set(normalizeTranscriptSpeakerKey(`Speaker ${rawLabel}`), rawLabel);
  });
  Object.entries(session?.speakerAliases || {}).forEach(([rawLabel, label]) => {
    if (!rawLabel || !label) return;
    map.set(normalizeTranscriptSpeakerKey(label), String(rawLabel).trim());
  });

  const usedRawLabels = new Set([...map.values()].filter(Boolean));
  getManualSpeakerEventsForSession(session).forEach((event) => {
    const normalizedLabel = normalizeTranscriptSpeakerKey(event?.speakerLabel || '');
    if (!normalizedLabel || map.has(normalizedLabel)) return;
    map.set(
      normalizedLabel,
      getNextUnusedCanonicalRawLabel(usedRawLabels, parseSpeakerNames(session?.speakerNames || state.settings.speakerNames || '').length)
    );
  });

  return map;
}

function getNextUnusedCanonicalRawLabel(usedRawLabels = new Set(), startIndex = 0) {
  for (let index = startIndex; index < 26; index += 1) {
    const candidate = String.fromCharCode(65 + index);
    if (!usedRawLabels.has(candidate)) {
      usedRawLabels.add(candidate);
      return candidate;
    }
  }
  const fallback = `U${usedRawLabels.size + 1}`;
  usedRawLabels.add(fallback);
  return fallback;
}

function getCanonicalRawSpeakerLabelForManualLabel(label, session = state.currentSession, usedRawLabels = new Set()) {
  const labelMap = buildManualLabelToCanonicalRawMap(session);
  const normalized = normalizeTranscriptSpeakerKey(label);
  const mapped = labelMap.get(normalized);
  if (mapped) {
    usedRawLabels.add(mapped);
    return mapped;
  }
  return getNextUnusedCanonicalRawLabel(usedRawLabels, parseSpeakerNames(session?.speakerNames || state.settings.speakerNames || '').length);
}

function buildCanonicalFinalDiarizedSegments({ diarizedSegments = [], session = state.currentSession, batchIndex = 0 } = {}) {
  const manualSlots = buildManualSpeakerSlots(session, state.currentSegments);
  const usedRawLabels = new Set(Object.keys(session?.speakerAliases || {}).map((label) => String(label || '').trim()).filter(Boolean));
  const localSpeakerAssignments = new Map();

  diarizedSegments.forEach((segment) => {
    const localSpeaker = String(segment.speaker || '').trim();
    if (!localSpeaker) return;
    const localStartMs = Number(segment.startMs || 0);
    const localEndMs = Number(segment.endMs || localStartMs);
    if (localEndMs <= localStartMs) return;

    const overlapByLabel = new Map();
    manualSlots.forEach((slot) => {
      const sharedMs = overlapMs(localStartMs, localEndMs, slot.startMs, slot.endMs);
      if (sharedMs <= 0) return;
      overlapByLabel.set(slot.label, (overlapByLabel.get(slot.label) || 0) + sharedMs);
    });

    const bestManualMatch = [...overlapByLabel.entries()].sort((left, right) => right[1] - left[1])[0] || null;
    if (!localSpeakerAssignments.has(localSpeaker)) {
      if (bestManualMatch && bestManualMatch[1] >= 1200) {
        const [label] = bestManualMatch;
        localSpeakerAssignments.set(localSpeaker, {
          rawSpeaker: getCanonicalRawSpeakerLabelForManualLabel(label, session, usedRawLabels),
          label,
        });
      } else {
        const rawSpeaker = getNextUnusedCanonicalRawLabel(
          usedRawLabels,
          Math.max(parseSpeakerNames(session?.speakerNames || state.settings.speakerNames || '').length, batchIndex)
        );
        localSpeakerAssignments.set(localSpeaker, {
          rawSpeaker,
          label: formatSpeakerLabel(rawSpeaker),
        });
      }
    }
  });

  return diarizedSegments.map((segment) => {
    const localSpeaker = String(segment.speaker || '').trim();
    const assignment = localSpeakerAssignments.get(localSpeaker);
    if (!assignment) return segment;
    return {
      ...segment,
      speaker: assignment.rawSpeaker,
      label: assignment.label,
    };
  });
}

function getSpeakerSummaryKey(rawLabel = '', label = '') {
  const normalizedLabel = normalizeTranscriptSpeakerKey(label || '');
  const normalizedDefaultLabel = normalizeTranscriptSpeakerKey(getDefaultSpeakerLabel(rawLabel));
  if (normalizedLabel && normalizedLabel !== normalizedDefaultLabel) {
    return normalizedLabel;
  }
  return normalizeTranscriptSpeakerKey(rawLabel || label || '');
}

function getSpeakerSummaryKeyForManualLabel(label, session = state.currentSession) {
  const normalizedLabel = String(label || '').trim();
  if (!normalizedLabel) return getSpeakerSummaryKey('', label);
  const rawLabel = getCanonicalRawSpeakerLabelForManualLabel(normalizedLabel, session, new Set());
  return getSpeakerSummaryKey(rawLabel, normalizedLabel);
}

function getSpeakerSummaryKeyForSegment(segment) {
  return getSpeakerSummaryKey(getSegmentRawSpeakerLabel(segment), getTranscriptSpeakerLabel(segment) || segment?.speakerLabel || '');
}

function pruneExpandedSpeakerKeys(summary = []) {
  const validKeys = new Set(summary.map((speaker) => speaker.key).filter(Boolean));
  state.speakerSummaryExpandedKeys = new Set(
    [...state.speakerSummaryExpandedKeys].filter((key) => validKeys.has(key))
  );
}

function buildSpeakerSegmentsForSummary(speaker) {
  const speakerKey = speaker?.key || getSpeakerSummaryKey(speaker?.rawLabel, speaker?.label);
  if (!speakerKey) return [];

  return state.currentSegments
    .filter((segment) => getSpeakerSummaryKeyForSegment(segment) === speakerKey)
    .sort((left, right) => {
      const leftStart = left.startMs ?? left.endMs ?? 0;
      const rightStart = right.startMs ?? right.endMs ?? 0;
      return leftStart - rightStart || (left.sequence || 0) - (right.sequence || 0);
    });
}

function renderSpeakerSlotDetails(speaker) {
  if (!speaker?.slots?.length) return '';

  return `
    <div class="speaker-slot-list">
      ${speaker.slots
        .map(
          (slot, index) => `
            <div class="speaker-slot-row">
              <button
                class="speaker-slot-row__play"
                type="button"
                data-speaker-action="play-slot"
                data-start-ms="${Number(slot.startMs || 0)}"
                aria-label="Play ${escapeHtml(speaker.label)} slot ${index + 1}"
              >${escapeHtml(`${formatDuration(slot.startMs || 0)} → ${formatDuration(slot.endMs || 0)}`)}</button>
              <div class="speaker-slot-row__meta">
                <strong>${escapeHtml(formatDuration(slot.speechMs || 0))}</strong>
                <small>${escapeHtml(`${slot.segmentCount || 0} segment${slot.segmentCount === 1 ? '' : 's'} • window ${formatDuration(slot.windowMs || 0)}`)}</small>
              </div>
            </div>`
        )
        .join('')}
    </div>
  `;
}

function renderSpeakerSegmentDetails(speaker) {
  const speakerSegments = buildSpeakerSegmentsForSummary(speaker);
  const slotDetails = renderSpeakerSlotDetails(speaker);
  if (!speakerSegments.length) {
    return `${slotDetails || ''}<div class="speaker-stat__details-empty">No saved transcript text for this speaker yet.</div>`;
  }

  return `
    <div class="speaker-stat__details-list">
      ${slotDetails}
      ${speakerSegments
        .map((segment) => {
          const sourceText = String(segment.sourceText || '').trim();
          const translatedText = String(segment.translatedText || segment.translatedDraft || '').trim();
          const segmentStartMs = Number(segment.startMs ?? segment.endMs ?? 0);
          return `
            <div class="speaker-detail-row">
              <button
                class="speaker-detail-row__time speaker-detail-row__time-button"
                type="button"
                data-speaker-action="play-segment"
                data-start-ms="${segmentStartMs}"
                aria-label="Play from ${escapeHtml(buildTranscriptTimestamp(segment))}"
              >${escapeHtml(buildTranscriptTimestamp(segment))}</button>
              <div class="speaker-detail-row__copy">
                <p class="speaker-detail-row__source">${escapeHtml(sourceText || 'No transcript text saved yet.')}</p>
                ${translatedText ? `<p class="speaker-detail-row__target">${escapeHtml(translatedText)}</p>` : ''}
              </div>
            </div>
          `;
        })
        .join('')}
    </div>
  `;
}

function toggleSpeakerSummaryExpansion(key) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return;

  const nextExpandedKeys = new Set(state.speakerSummaryExpandedKeys);
  if (nextExpandedKeys.has(normalizedKey)) {
    nextExpandedKeys.delete(normalizedKey);
  } else {
    nextExpandedKeys.add(normalizedKey);
  }

  state.speakerSummaryExpandedKeys = nextExpandedKeys;
  renderSpeakerInsights();
}

function renderSpeakerSummaryCards(summary, { includeTotalCard = true } = {}) {
  if (!summary.length) {
    state.speakerSummaryExpandedKeys = new Set();
    return '';
  }

  pruneExpandedSpeakerKeys(summary);

  const totalDurationMs = summary.reduce((total, speaker) => total + speaker.durationMs, 0);
  const currentPlaybackSegment = state.currentSegments.find((segment) => segment.id === state.sessionPlaybackSegmentId);
  const currentPlaybackSpeakerKey = currentPlaybackSegment ? getSpeakerSummaryKeyForSegment(currentPlaybackSegment) : '';
  const speakerPlaybackEnabled = state.sessionRecordings.some((recording) => hasRecordingBlob(recording));

  return [
    includeTotalCard
      ? `
      <div class="speaker-total">
        <strong>Automatic diarized speaker time</strong>
        <span>${formatDuration(totalDurationMs)}</span>
        <small>From speaker identification across diarized transcript segments.</small>
      </div>
    `
      : '',
    ...summary.map(
      (speaker) => {
        const expanded = state.speakerSummaryExpandedKeys.has(speaker.key);
        const speakerPlaying = currentPlaybackSpeakerKey && currentPlaybackSpeakerKey === speaker.key;
        const speakerPlayMarkup =
          speakerPlaybackEnabled && Number.isFinite(speaker.startMs)
            ? `<button
                class="icon-button speaker-stat__icon-button ${speakerPlaying ? 'speaker-stat__icon-button--active' : ''}"
                type="button"
                data-speaker-action="play-speaker"
                data-speaker-key="${escapeHtml(speaker.key)}"
                data-start-ms="${Number(speaker.startMs || 0)}"
                aria-label="Play ${escapeHtml(speaker.label)}"
                title="Play ${escapeHtml(speaker.label)}"
              >🔊</button>`
            : '';
        return `
        <div class="speaker-stat ${expanded ? 'speaker-stat--expanded' : ''} ${speakerPlaying ? 'speaker-stat--playing' : ''}" data-speaker-key="${escapeHtml(
          speaker.key
        )}">
          <div class="speaker-stat__top-row">
            <button
              class="speaker-stat__toggle"
              type="button"
              data-speaker-action="toggle"
              data-speaker-key="${escapeHtml(speaker.key)}"
              aria-expanded="${expanded ? 'true' : 'false'}"
            >
              <div class="speaker-stat__content">
                <div class="speaker-stat__header-row">
                  <strong>${escapeHtml(speaker.label)}</strong>
                </div>
                <small>${escapeHtml(
                  [
                    speaker.defaultLabel && speaker.defaultLabel !== speaker.label ? speaker.defaultLabel : null,
                    speaker.slotCount ? `${speaker.slotCount} slot${speaker.slotCount === 1 ? '' : 's'}` : null,
                    `${speaker.segments} segment${speaker.segments === 1 ? '' : 's'}`,
                  ]
                    .filter(Boolean)
                    .join(' • ')
                )}</small>
              </div>
              <div class="speaker-stat__toggle-side">
                <span class="speaker-stat__duration">${formatDuration(speaker.durationMs)}</span>
                <span class="speaker-stat__chevron" aria-hidden="true">${expanded ? '▾' : '▸'}</span>
              </div>
            </button>
            <div class="speaker-stat__actions">
              ${speakerPlayMarkup}
              ${
                speaker.rawLabel
                  ? `<button class="button button--ghost button--small" data-speaker-action="rename" data-speaker-raw-label="${escapeHtml(
                      speaker.rawLabel
                    )}">Rename</button>`
                  : ''
              }
            </div>
          </div>
          ${
            expanded
              ? `<div class="speaker-stat__details">${renderSpeakerSegmentDetails(speaker)}</div>`
              : ''
          }
        </div>
      `;
      }
    ),
  ]
    .filter(Boolean)
    .join('');
}

function buildSpeakerTimingSummaryRows(slotRollup, summary = []) {
  const manualSlots = Array.isArray(slotRollup?.slots) ? slotRollup.slots : [];
  const manualTotalByKey = new Map(
    (Array.isArray(slotRollup?.speakers) ? slotRollup.speakers : []).map((speaker) => [speaker.key, Math.max(0, Number(speaker.windowMs || 0))])
  );
  const speakerPartIndex = new Map();

  const rows = manualSlots
    .map((slot) => {
      const speakerKey = getSpeakerSummaryKeyForManualLabel(slot.label || 'Speaker');
      const nextPart = (speakerPartIndex.get(speakerKey) || 0) + 1;
      speakerPartIndex.set(speakerKey, nextPart);
      const totalMs = Math.max(0, Number(manualTotalByKey.get(speakerKey) ?? slot.windowMs ?? 0));
      return {
        key: `${speakerKey}:${slot.id}:${nextPart}`,
        speakerKey,
        label: slot.label || 'Speaker',
        note: `Part ${nextPart}`,
        manualMs: Math.max(0, Number(slot.windowMs || 0)),
        autoMs: Math.max(0, Number(slot.speechMs || 0)),
        totalMs,
        startMs: Math.max(0, Number(slot.startMs || 0)),
      };
    })
    .sort((left, right) => left.startMs - right.startMs);

  return rows;
}

function formatSpeakerTimingSummaryDuration(ms = 0) {
  return formatManualStopwatchTime(ms);
}

function renderSpeakerTimingSummary(slotRollup, summary, { final = false } = {}) {
  const rows = buildSpeakerTimingSummaryRows(slotRollup, summary);
  if (!rows.length) return '';

  const totalAutoMs = rows.reduce((total, row) => total + Math.max(0, Number(row.autoMs || 0)), 0);
  const renderedSpeakerKeys = new Set();

  return `
    <div class="speaker-timing-summary">
      <div class="speaker-timing-summary__totals">
        <div class="speaker-timing-summary__total speaker-timing-summary__total--manual">
          <span>Manual stopwatch</span>
          <strong>${formatSpeakerTimingSummaryDuration(slotRollup?.totalWindowMs || 0)}</strong>
        </div>
        <div class="speaker-timing-summary__total speaker-timing-summary__total--auto">
          <span>${final ? 'Auto matched speech' : 'Auto matched speech'}</span>
          <strong>${formatSpeakerTimingSummaryDuration(slotRollup?.totalSpeechMs || 0)}</strong>
        </div>
      </div>
      <div class="speaker-timing-summary__table-wrap">
        <div class="speaker-timing-summary__table" role="table" aria-label="Speaker timing summary">
          <div class="speaker-timing-summary__head" role="row">
            <span role="columnheader">Speaker</span>
            <span role="columnheader">Part</span>
            <span role="columnheader">Manual</span>
            <span role="columnheader">Auto</span>
            <span role="columnheader">Total</span>
          </div>
          ${rows
            .map((row) => {
              const firstRowForSpeaker = !renderedSpeakerKeys.has(row.speakerKey);
              renderedSpeakerKeys.add(row.speakerKey);
              return `
                <div class="speaker-timing-summary__row" role="row">
                  <button
                    class="speaker-timing-summary__speaker"
                    type="button"
                    data-speaker-action="play-slot"
                    data-start-ms="${Number(row.startMs || 0)}"
                    aria-label="Play ${escapeHtml(row.label)} ${escapeHtml(row.note || 'segment')}"
                  >
                    <strong>${escapeHtml(row.label)}</strong>
                  </button>
                  <span class="speaker-timing-summary__part" role="cell">${escapeHtml(row.note || '')}</span>
                  <span role="cell">${formatSpeakerTimingSummaryDuration(row.manualMs || 0)}</span>
                  <span role="cell">${formatSpeakerTimingSummaryDuration(row.autoMs || 0)}</span>
                  <span role="cell">${firstRowForSpeaker ? formatSpeakerTimingSummaryDuration(row.totalMs || 0) : '—'}</span>
                </div>`;
            })
            .join('')}
          <div class="speaker-timing-summary__foot" role="row">
            <strong role="cell">All speakers</strong>
            <span role="cell">Σ</span>
            <span role="cell">${formatSpeakerTimingSummaryDuration(slotRollup?.totalWindowMs || 0)}</span>
            <span role="cell">${formatSpeakerTimingSummaryDuration(totalAutoMs)}</span>
            <span role="cell">${formatSpeakerTimingSummaryDuration(slotRollup?.totalWindowMs || 0)}</span>
          </div>
        </div>
      </div>
      <small class="speaker-timing-summary__note">${escapeHtml(
        final
          ? 'Manual shows the exact stopwatch window you marked. Auto shows the exact transcript speech found inside that window after the final pass. Total shows that speaker’s summed manual stopwatch time on the first row only, and the footer uses the same exact stopwatch basis.'
          : 'Manual shows the exact stopwatch window you marked. Auto shows the exact transcript speech found inside that window so far. Total shows that speaker’s summed manual stopwatch time on the first row only, and the footer uses the same exact stopwatch basis.'
      )}</small>
    </div>
  `;
}

function renderSpeakerSummaryDetailsDisclosure(summary) {
  if (!summary.length) return '';

  return `
    <details class="speaker-details-disclosure">
      <summary>Detailed transcript by speaker</summary>
      <div class="speaker-details-disclosure__body">
        ${renderSpeakerSummaryCards(summary, { includeTotalCard: false })}
      </div>
    </details>
  `;
}

function hasRecordingBlob(recording) {
  return Boolean(recording?.blob && Number(recording.blob.size || 0) > 0);
}

function getPendingRecordingPasses(sessionId = state.currentSession?.id) {
  if (!sessionId) return [];
  return state.sessionRecordings.filter(
    (recording) => recording.sessionId === sessionId && !recording.diarizedAt && hasRecordingBlob(recording)
  );
}

function setSpeakerFinalizeProgress(progress = null) {
  state.speakerFinalizeProgress = progress
    ? {
        ...(state.speakerFinalizeProgress || {}),
        ...progress,
      }
    : null;
}

function buildSpeakerProcessingCardState({ pendingSegments = 0, pendingRecordingPasses = 0, queueBusy = false } = {}) {
  if (state.speakerFinalizeInProgress) {
    const progress = state.speakerFinalizeProgress || {};
    const total = Math.max(0, Number(progress.total || pendingRecordingPasses || 0));
    const completed = Math.max(0, Number(progress.completed || 0));
    const failed = Math.max(0, Number(progress.failed || 0));
    const processed = Math.min(total || 0, completed + failed);
    const currentIndex = total > 0 ? Math.min(total, Math.max(Number(progress.currentIndex || 0), processed || 1)) : 0;
    const determinate = total > 0;
    const ratio = determinate
      ? Math.min(1, Math.max(processed / total, currentIndex ? ((currentIndex - 1) + 0.45) / total : 0))
      : 0;
    const retryCount = failed || 0;
    const note = String(progress.note || '').trim() || 'This can take a moment after stopping the session.';
    return {
      title: 'Processing speaker timing',
      meta: determinate
        ? `${completed} of ${total} clip${total === 1 ? '' : 's'} done${retryCount ? `, ${retryCount} still queued` : ''}`
        : 'Working through the queued speaker timing...',
      note,
      determinate,
      ratio,
    };
  }

  if (queueBusy) {
    const activeChunks = Math.max(0, Number(state.speakerTrackingPendingChunks || 0)) + (state.speakerTrackingInFlight ? 1 : 0);
    return {
      title: 'Processing speaker timing',
      meta: pendingSegments
        ? `${pendingSegments} raw segment${pendingSegments === 1 ? '' : 's'} still being labeled`
        : `${activeChunks} speaker chunk${activeChunks === 1 ? '' : 's'} in flight`,
      note: 'The background summary can lag a little behind the live transcript.',
      determinate: false,
      ratio: 0,
    };
  }

  return null;
}

function renderSpeakerProcessingCard(progress) {
  if (!progress) return '';

  const width = progress.determinate ? `${Math.max(6, Math.round(progress.ratio * 100))}%` : '42%';

  return `
    <div class="speaker-progress ${progress.determinate ? '' : 'speaker-progress--indeterminate'}" role="status" aria-live="polite">
      <div class="speaker-progress__top">
        <strong>${escapeHtml(progress.title)}</strong>
        <span class="speaker-progress__meta">${escapeHtml(progress.meta || '')}</span>
      </div>
      <div class="speaker-progress__track" aria-hidden="true">
        <span class="speaker-progress__fill" style="width: ${width}"></span>
      </div>
      ${progress.note ? `<small class="speaker-progress__note">${escapeHtml(progress.note)}</small>` : ''}
    </div>
  `;
}

function getPendingSpeakerSegmentCount(sessionId = state.currentSession?.id) {
  if (!sessionId) return 0;
  return state.currentSegments.filter((segment) => segment.sessionId === sessionId && segment.speakerStatus === 'pending').length;
}

function canStartSpeakerTrackingManually(session = state.currentSession) {
  if (!session || !state.speakerTrackingSupported) return false;
  if (session.status !== 'active') return false;
  const stream = state.client?.mediaStream;
  if (!stream?.getAudioTracks) return false;
  return stream.getAudioTracks().some((track) => track.readyState !== 'ended');
}

function renderSpeakerFinalizeButton() {
  if (!elements.finalizeSpeakerButton) return;

  const session = state.currentSession;
  const activeCapture = Boolean(session && session.status === 'active' && ['connecting', 'listening', 'reconnecting'].includes(state.runtimeStatus));
  const hasRecorder = Boolean(
    session &&
      state.speakerTrackingSessionId === session.id &&
      state.speakerRecorder &&
      state.speakerRecorder.state !== 'inactive'
  );
  const queueBusy = state.speakerTrackingPendingChunks > 0 || state.speakerTrackingInFlight;
  const pendingSegments = getPendingSpeakerSegmentCount(session?.id);
  const pendingRecordingPasses = getPendingRecordingPasses(session?.id).length;
  const hasSummary = state.currentSegments.some((segment) => Boolean(getTranscriptSpeakerLabel(segment) || segment.speakerLabel));
  const hasFinalSpeakerTiming = Boolean(session?.speakerFinalizedAt);
  const canStartManually = canStartSpeakerTrackingManually(session) && !hasRecorder && !queueBusy && !pendingSegments;
  const canFinalize = Boolean(
    session && !activeCapture && state.speakerTrackingSupported && (hasRecorder || queueBusy || pendingSegments || pendingRecordingPasses || canStartManually)
  );

  elements.finalizeSpeakerButton.classList.toggle('hidden', Boolean(activeCapture && !state.speakerFinalizeInProgress));

  elements.finalizeSpeakerButton.disabled = state.speakerFinalizeInProgress || !canFinalize;

  if (!session) {
    elements.finalizeSpeakerButton.textContent = 'Run final speaker timing';
    return;
  }

  if (!state.speakerTrackingSupported) {
    elements.finalizeSpeakerButton.textContent = 'Speaker timing unavailable';
    return;
  }

  if (activeCapture && !state.speakerFinalizeInProgress) {
    elements.finalizeSpeakerButton.textContent = 'Available after stopping';
    return;
  }

  if (state.speakerFinalizeInProgress) {
    const progress = state.speakerFinalizeProgress;
    if (progress?.total > 0) {
      const total = Math.max(1, Number(progress.total || 0));
      const processed = Math.min(total, Number(progress.completed || 0) + Number(progress.failed || 0));
      const current = Math.min(total, Math.max(Number(progress.currentIndex || 0), processed < total ? processed + 1 : processed, 1));
      elements.finalizeSpeakerButton.textContent = `Finalizing speaker timing (${current}/${total})…`;
    } else {
      elements.finalizeSpeakerButton.textContent =
        hasRecorder || queueBusy || pendingSegments || pendingRecordingPasses ? 'Finalizing speaker timing…' : 'Starting speaker timing…';
    }
    return;
  }

  if (canStartManually) {
    elements.finalizeSpeakerButton.textContent = 'Run final speaker timing';
    return;
  }

  if (hasRecorder && !queueBusy && !pendingSegments) {
    elements.finalizeSpeakerButton.textContent = 'Capture final speaker batch now';
    return;
  }

  if (pendingRecordingPasses) {
    elements.finalizeSpeakerButton.textContent = `Run final speaker timing (${pendingRecordingPasses} clip${pendingRecordingPasses === 1 ? '' : 's'})`;
    return;
  }

  if (pendingSegments || queueBusy || hasRecorder) {
    elements.finalizeSpeakerButton.textContent = 'Run final speaker timing';
    return;
  }

  elements.finalizeSpeakerButton.textContent = hasFinalSpeakerTiming ? 'Final speaker timing ready' : hasSummary ? 'Speaker timing available' : 'No speaker timing yet';
}

function renderSpeakerInsights() {
  if (!elements.speakerStatusLine || !elements.speakerSummary) return;

  const session = state.currentSession;
  const pendingSegments = getPendingSpeakerSegmentCount(session?.id);
  const pendingRecordingPasses = getPendingRecordingPasses(session?.id).length;
  const queueBusy = state.speakerTrackingPendingChunks > 0 || state.speakerTrackingInFlight;
  const summary = buildSpeakerSummary(state.currentSegments);
  const slotRollup = buildManualSpeakerSlotRollup(session, state.currentSegments);
  const sessionEnded = session?.status === 'ended';
  const stoppedSession = session && ['paused', 'ended'].includes(session.status);
  const activeCapture = Boolean(session && session.status === 'active' && ['connecting', 'listening', 'reconnecting'].includes(state.runtimeStatus));
  const canStartManually = canStartSpeakerTrackingManually(session);
  const hasFinalSpeakerTiming = Boolean(session?.speakerFinalizedAt);
  const speakerProcessingCard = renderSpeakerProcessingCard(
    buildSpeakerProcessingCardState({ pendingSegments, pendingRecordingPasses, queueBusy })
  );

  if (!session) {
    elements.speakerStatusLine.textContent = 'Speaker timing will appear here during a live session.';
    elements.speakerSummary.innerHTML = '<div class="note">No speaker timing data yet.</div>';
    renderSpeakerFinalizeButton();
    return;
  }

  if (!state.speakerTrackingSupported) {
    elements.speakerStatusLine.textContent = 'This browser does not support background speaker detection.';
    elements.speakerSummary.innerHTML = summary.length
      ? [renderSpeakerTimingSummary(slotRollup, summary, { final: hasFinalSpeakerTiming }), renderSpeakerSummaryDetailsDisclosure(summary)]
          .filter(Boolean)
          .join('')
      : '<div class="note">Speaker timing is unavailable in this browser.</div>';
    renderSpeakerFinalizeButton();
    return;
  }

  if (state.speakerFinalizeInProgress) {
    elements.speakerStatusLine.textContent = state.speakerFinalizeProgress?.statusLine || state.speakerTrackingStatus;
  } else if (pendingRecordingPasses) {
    elements.speakerStatusLine.textContent = `Showing provisional speaker hints. ${pendingRecordingPasses} saved recording clip${pendingRecordingPasses === 1 ? '' : 's'} ${
      pendingRecordingPasses === 1 ? 'is' : 'are'
    } ready for the final speaker pass.`;
  } else if (pendingSegments) {
    elements.speakerStatusLine.textContent = `Showing provisional speaker hints. ${pendingSegments} raw segment${pendingSegments === 1 ? '' : 's'} ${
      pendingSegments === 1 ? 'is' : 'are'
    } still processing.`;
  } else if (!activeCapture && canStartManually && !state.speakerRecorder && !state.speakerTrackingInFlight) {
    elements.speakerStatusLine.textContent = 'The final speaker pass is ready. Tap the button above to run it now.';
  } else if (sessionEnded && hasFinalSpeakerTiming) {
    elements.speakerStatusLine.textContent = 'Final speaker timing is ready. The summary below lines up each manual segment with the automatic match and the speaker total.';
  } else if (sessionEnded && summary.length) {
    elements.speakerStatusLine.textContent = 'Session ended. The speaker view below is still provisional until you run the final speaker pass.';
  } else if (sessionEnded) {
    elements.speakerStatusLine.textContent = 'Session ended. No finalized speaker timing is available for this session.';
  } else if (stoppedSession && hasFinalSpeakerTiming) {
    elements.speakerStatusLine.textContent = 'Final speaker timing is ready. The summary below lines up each manual segment with the automatic match and the speaker total.';
  } else if (stoppedSession && summary.length) {
    elements.speakerStatusLine.textContent = 'Capture stopped. The speaker view below is provisional until you run the final speaker pass.';
  } else if (stoppedSession) {
    elements.speakerStatusLine.textContent = 'Capture stopped. No finalized speaker timing is available for this session.';
  } else if (summary.length) {
    elements.speakerStatusLine.textContent = 'Showing provisional speaker hints while capture runs. Stop the session, then run the final speaker pass for a full reconciliation.';
  } else {
    elements.speakerStatusLine.textContent = state.speakerTrackingStatus;
  }

  const speakerTimingSummaryMarkup = renderSpeakerTimingSummary(slotRollup, summary, { final: hasFinalSpeakerTiming });
  const speakerDetailsMarkup = renderSpeakerSummaryDetailsDisclosure(summary);

  if (!summary.length) {
    elements.speakerSummary.innerHTML = [
      speakerProcessingCard,
      speakerTimingSummaryMarkup,
      '<div class="note">Speaker timing runs quietly in the background and can lag a little behind the live text. Tap the button above to start the full post-session speaker pass when you are done recording.</div>',
    ]
      .filter(Boolean)
      .join('');
    renderSpeakerFinalizeButton();
    return;
  }

  elements.speakerSummary.innerHTML = [speakerProcessingCard, speakerTimingSummaryMarkup, speakerDetailsMarkup].filter(Boolean).join('');
  updateSpeakerPlaybackIndicator();
  renderSpeakerFinalizeButton();
}

function getTranscriptDisplayCounts() {
  if (!state.currentSession && !state.currentSegments.length) {
    return {
      visibleRows: 0,
      savedSegments: 0,
    };
  }

  const liveDraft = buildLiveTranscriptState();
  const feedRows = buildTranscriptFeedRows(liveDraft.sourceLabel, liveDraft.targetLabel);
  const liveRow = buildTranscriptDisplayItemFromLiveDraft(liveDraft);
  const { rows: mergedRows, liveRow: appendedLiveRow } = mergeLiveRowIntoFeedRows(feedRows, liveRow);

  return {
    visibleRows: mergedRows.length + (appendedLiveRow ? 1 : 0),
    savedSegments: state.currentSegments.length,
  };
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
    if (elements.segmentCountLabel) elements.segmentCountLabel.textContent = 'Rows shown';
    elements.segmentCountValue.textContent = '0';
    if (elements.segmentCountMeta) elements.segmentCountMeta.textContent = '0 saved segments';
    renderTopbarTitle();
    return;
  }

  const counts = getTranscriptDisplayCounts();

  elements.sessionTitle.textContent = session.title;
  elements.sessionMeta.textContent = buildSessionMeta(session);
  elements.durationValue.textContent = formatDuration(getEffectiveActiveDuration());
  elements.speechOnlyValue.textContent = formatDuration(getEffectiveSpeechDuration());
  if (elements.segmentCountLabel) elements.segmentCountLabel.textContent = 'Rows shown';
  elements.segmentCountValue.textContent = String(counts.visibleRows);
  if (elements.segmentCountMeta) {
    elements.segmentCountMeta.textContent = `${counts.savedSegments} saved segment${counts.savedSegments === 1 ? '' : 's'}`;
  }
  renderTopbarTitle();
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
      sourceText: '',
      targetText: '',
      liveStateLabel: 'Ready',
      liveBadge: 'Live transcript',
      liveMeta: 'New text will append to the transcript below as speech arrives.',
      timestamp: 'Live',
      targetPending: false,
      hasActiveSpeech: false,
    };
  }

  const sourceDraft = String(session.draftSource || '').trim();
  const targetDraft = String(session.draftTranslation || '').trim();
  const hasActiveSpeech = Boolean(sourceDraft) && (state.speechActive || Boolean(state.activeDraftItemId));
  const lastSegment = state.currentSegments[state.currentSegments.length - 1];
  const draftEchoesLastFinal = Boolean(
    !state.activeDraftItemId &&
      lastSegment &&
      sourceDraft &&
      normalizeTranscript(lastSegment.sourceText) === normalizeTranscript(sourceDraft) &&
      (!targetDraft ||
        normalizeTranscript(lastSegment.translatedText || lastSegment.translatedDraft || '') === normalizeTranscript(targetDraft))
  );
  const hasRenderableLiveDraft = Boolean((sourceDraft || targetDraft) && !draftEchoesLastFinal);
  const browsingEarlier = !state.transcriptPinnedToBottom;

  let liveStateLabel = state.settings.autoScroll ? 'Following live' : 'Auto-follow off';
  let liveMeta = browsingEarlier
    ? 'You are reading earlier transcript text. Jump to live to catch up.'
    : 'New text appends at the bottom as speech continues.';

  if (browsingEarlier && (state.currentSegments.length || hasRenderableLiveDraft)) {
    liveStateLabel = 'Reading earlier text';
  } else if (!hasRenderableLiveDraft && state.currentSegments.length) {
    liveStateLabel = 'Waiting';
    liveMeta = 'The transcript stays ready and will append the next segment below.';
  } else if (hasActiveSpeech && targetDraft) {
    liveStateLabel = 'Updating live';
    liveMeta = 'The newest source and translation text continue to append below.';
  } else if (hasActiveSpeech) {
    liveStateLabel = 'Listening';
    liveMeta = 'The latest source text is visible now and translation will follow.';
  } else if (sourceDraft && targetDraft) {
    liveStateLabel = 'Settling';
    liveMeta = 'It will stay in the live transcript and finalize shortly.';
  } else if (sourceDraft) {
    liveStateLabel = 'Translating';
    liveMeta = 'Translation will appear beneath it as soon as it is ready.';
  } else if (!state.currentSegments.length) {
    liveStateLabel = 'Waiting';
    liveMeta = 'Start listening and text will begin appending here.';
  }

  return {
    visible: hasRenderableLiveDraft,
    sourceLabel,
    targetLabel,
    sourceText: sourceDraft || (targetDraft ? 'Source text is settling…' : ''),
    targetText: targetDraft || (sourceDraft ? 'Translation is catching up…' : ''),
    liveStateLabel,
    liveBadge: hasActiveSpeech ? 'Live preview' : 'Preview holding',
    liveMeta,
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

function renderTranscriptParagraph({ kind, label, text, pending = false }) {
  return `
    <section class="transcript-paragraph transcript-paragraph--${kind}">
      ${label ? `<span class="transcript-paragraph__label">${escapeHtml(label)}</span>` : ''}
      <p class="transcript-paragraph__text ${pending ? 'transcript-paragraph__text--pending' : ''}">${escapeHtml(text)}</p>
    </section>
  `;
}

function getAutomaticSpeakerLabelForSegment(segment, session = state.currentSession) {
  if (!segment?.speakerRawLabel) return '';
  return resolveSpeakerLabel(segment.speakerRawLabel, session, getDefaultSpeakerLabel(segment.speakerRawLabel));
}

function getTranscriptSpeakerLabel(segment) {
  const manualLabel = getManualSpeakerLabelForSegment(segment);
  if (manualLabel) return manualLabel;
  if (segment.speakerLabel) return String(segment.speakerLabel || '').trim();
  if (segment.speakerRawLabel) return getAutomaticSpeakerLabelForSegment(segment);
  const seededNames = parseSpeakerNames(state.currentSession?.speakerNames || state.settings.speakerNames || '');
  if (seededNames.length === 1) {
    return seededNames[0];
  }
  return 'Speaker';
}

function getTranscriptAuxParts(segment) {
  const translatedText = String(segment.translatedText || segment.translatedDraft || '').trim();
  const translationPending = !translatedText && segment.translationStatus !== 'error';
  const auxParts = [];
  if (segment.translationStatus === 'draft') auxParts.push('Translation polishing');
  else if (translationPending) auxParts.push('Translation pending');
  return auxParts;
}

function buildTranscriptDisplayItemFromSegment(segment, { sourceLabel, targetLabel }) {
  const translatedText = String(segment.translatedText || segment.translatedDraft || '').trim();
  const translationPending = !translatedText && segment.translationStatus !== 'error';
  return {
    key: segment.id,
    title: getTranscriptSpeakerLabel(segment),
    speakerKey: normalizeTranscriptSpeakerKey(segment.speakerLabel || segment.speakerRawLabel || ''),
    timestamp: buildTranscriptTimestamp(segment),
    auxText: getTranscriptAuxParts(segment).join(' • '),
    sourceLabel,
    targetLabel,
    startMs: Number(segment.startMs || 0),
    endMs: Number(segment.endMs || segment.startMs || 0),
    sourceText: String(segment.sourceText || '').trim(),
    targetText: translatedText || (segment.translationStatus === 'error' ? 'Translation unavailable.' : ''),
    targetPending: translationPending,
  };
}

function buildTranscriptDisplayItemFromLiveDraft(liveDraft) {
  if (!liveDraft.visible) return null;

  return {
    key: 'live-preview',
    title: '',
    speakerKey: '',
    timestamp: liveDraft.timestamp || 'Live',
    auxText: '',
    sourceLabel: liveDraft.sourceLabel,
    targetLabel: liveDraft.targetLabel,
    startMs: Number(state.currentSession?.activeDurationMs || 0),
    endMs: Number(state.currentSession?.activeDurationMs || 0),
    sourceText: liveDraft.sourceText || 'Listening…',
    targetText: liveDraft.targetText || '',
    targetPending: liveDraft.targetPending,
  };
}

function mergeReaderWindowText(parts) {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildReaderWindowFromItems(items, { sourceLabel, targetLabel, key, title } = {}) {
  const sourceText = mergeReaderWindowText(items.map((item) => item.sourceText));
  const targetPending = items.some((item) => item.targetPending);
  const stableTargetText = mergeReaderWindowText(items.map((item) => (!item.targetPending ? item.targetText : '')));
  const fallbackTargetText = String(items[items.length - 1]?.targetText || '').trim();

  return {
    key: key || items.map((item) => item.key).filter(Boolean).join(':'),
    title: title || items[items.length - 1]?.title || '',
    timestamp: items[items.length - 1]?.timestamp || '',
    auxText: targetPending ? 'Translation pending' : '',
    sourceLabel,
    targetLabel,
    sourceText: sourceText || 'Listening…',
    targetText: stableTargetText || (targetPending ? fallbackTargetText || 'Translation is catching up…' : ''),
    targetPending,
    sourceChars: sourceText.length,
    targetChars: stableTargetText.length,
    segmentCount: items.length,
  };
}

function isReaderWindowStable(windowItem) {
  if (!windowItem) return false;
  return windowItem.segmentCount >= 3 || windowItem.sourceChars >= 84 || windowItem.targetChars >= 84;
}

function isReaderWindowFull(windowItem) {
  if (!windowItem) return false;
  return windowItem.segmentCount >= 3 || windowItem.sourceChars >= 156 || windowItem.targetChars >= 156;
}

function buildCommittedReaderWindows(segments, { sourceLabel, targetLabel }) {
  const windows = [];
  let currentItems = [];

  for (const segment of segments) {
    currentItems.push(buildTranscriptDisplayItemFromSegment(segment, { sourceLabel, targetLabel }));
    const currentWindow = buildReaderWindowFromItems(currentItems, { sourceLabel, targetLabel });

    if (isReaderWindowFull(currentWindow)) {
      windows.push(currentWindow);
      currentItems = [];
    }
  }

  if (currentItems.length) {
    windows.push(buildReaderWindowFromItems(currentItems, { sourceLabel, targetLabel }));
  }

  return windows;
}

function buildPreviewReaderWindow({ previewWindow, livePreview, sourceLabel, targetLabel }) {
  if (previewWindow && livePreview) {
    return buildReaderWindowFromItems([previewWindow, livePreview], {
      sourceLabel,
      targetLabel,
      key: `${previewWindow.key}:live-preview`,
      title: livePreview.title || previewWindow.title || '',
    });
  }

  if (previewWindow) return previewWindow;
  if (livePreview) return buildReaderWindowFromItems([livePreview], { sourceLabel, targetLabel, key: livePreview.key, title: livePreview.title });
  return null;
}

function buildEmptyReaderSlot(role, { sourceLabel, targetLabel }) {
  if (role === 'previous') {
    return {
      role,
      empty: true,
      eyebrow: 'Previous',
      title: 'No previous sentence yet',
      sourceLabel,
      targetLabel,
    };
  }

  if (role === 'current') {
    return {
      role,
      empty: true,
      eyebrow: 'Read now',
      title: state.currentSession ? 'Waiting for the first sentence' : 'Start listening',
      sourceLabel,
      targetLabel,
    };
  }

  return {
    role,
    empty: true,
    eyebrow: 'Incoming',
    title: 'No incoming text yet',
    sourceLabel,
    targetLabel,
  };
}

function buildCompactReaderSlotText(slot, mode) {
  const sourceText = slot.sourceText || '';
  const targetText = !slot.targetPending ? slot.targetText || '' : '';

  if (mode === 'source') return sourceText || 'Listening…';
  if (mode === 'target') return targetText || slot.targetText || 'Translation is catching up…';
  if (sourceText && targetText) return `${sourceText} • ${targetText}`;
  return sourceText || targetText || slot.targetText || 'Listening…';
}

function renderTranscriptWindowSlot(slot) {
  const mode = TRANSCRIPT_VIEW_MODES.has(state.liveTranscriptView) ? state.liveTranscriptView : 'both';
  const showSource = mode !== 'target';
  const showTarget = mode !== 'source';
  const collapsePendingTarget = slot.role === 'current' && slot.targetPending;
  const effectiveShowSource = showSource && (!collapsePendingTarget || mode !== 'target');
  const effectiveShowTarget = showTarget && !collapsePendingTarget;
  const showPendingTargetNote = collapsePendingTarget && showTarget;
  const bodyClass = effectiveShowSource && effectiveShowTarget ? 'transcript-window__body--both' : 'transcript-window__body--single';
  const hasMeta = Boolean(slot.timestamp);
  const showParagraphLabels = slot.role === 'current';
  const showTitle = slot.empty;
  const useCompactBody = slot.role !== 'current' && !slot.empty;
  const compactText = useCompactBody ? buildCompactReaderSlotText(slot, mode) : '';

  return `
    <article class="transcript-window__slot transcript-window__slot--${slot.role}${slot.empty ? ' transcript-window__slot--empty' : ''}" data-reader-slot="${slot.role}">
      <div class="transcript-window__slot-head">
        <div class="transcript-window__slot-copy">
          <p class="transcript-window__eyebrow">${escapeHtml(slot.eyebrow)}</p>
          ${showTitle ? `<h4 class="transcript-window__title">${escapeHtml(slot.title)}</h4>` : ''}
        </div>
        ${
          hasMeta
            ? `<div class="transcript-pair__meta">
                <span class="transcript-pair__time">${escapeHtml(slot.timestamp || '')}</span>
              </div>`
            : ''
        }
      </div>
      ${
        !slot.empty
          ? useCompactBody
            ? `<p class="transcript-window__compact-line">${escapeHtml(compactText)}</p>`
            : `<div class="transcript-window__body ${bodyClass}">
                ${
                  effectiveShowSource
                    ? renderTranscriptParagraph({
                        kind: 'source',
                        label: showParagraphLabels ? slot.sourceLabel : '',
                        text: slot.sourceText || 'Listening…',
                      })
                    : ''
                }
                ${
                  effectiveShowTarget
                    ? renderTranscriptParagraph({
                        kind: 'target',
                        label: showParagraphLabels ? slot.targetLabel : '',
                        text: slot.targetText || 'Translation is catching up…',
                        pending: slot.targetPending,
                      })
                    : ''
                }
                ${
                  showPendingTargetNote
                    ? `<p class="transcript-window__pending-note">${escapeHtml(slot.targetLabel ? `${slot.targetLabel} catching up…` : 'Translation catching up…')}</p>`
                    : ''
                }
              </div>`
          : ''
      }
    </article>
  `;
}

function renderTranscriptLiveBand(liveDraft) {
  if (!elements.transcriptLiveBand) return;

  const sourceLabel = liveDraft.sourceLabel;
  const targetLabel = liveDraft.targetLabel;
  const committedWindows = buildCommittedReaderWindows(state.currentSegments, { sourceLabel, targetLabel });
  const livePreview = buildTranscriptDisplayItemFromLiveDraft(liveDraft);

  let currentCommitted = committedWindows[committedWindows.length - 1] || null;
  let previewCommitted = null;

  if (committedWindows.length > 1 && currentCommitted && !isReaderWindowStable(currentCommitted)) {
    previewCommitted = currentCommitted;
    currentCommitted = committedWindows[committedWindows.length - 2] || null;
  }

  const currentIndex = currentCommitted ? committedWindows.findIndex((item) => item.key === currentCommitted.key) : -1;
  const previousCommitted = currentIndex > 0 ? committedWindows[currentIndex - 1] : null;
  const previewWindow = buildPreviewReaderWindow({ previewWindow: previewCommitted, livePreview, sourceLabel, targetLabel });

  const previousSlot = previousCommitted
    ? {
        ...previousCommitted,
        role: 'previous',
        eyebrow: 'Previous',
      }
    : buildEmptyReaderSlot('previous', { sourceLabel, targetLabel });

  const currentSlot = currentCommitted
    ? {
        ...currentCommitted,
        role: 'current',
        eyebrow: 'Read now',
      }
    : livePreview
      ? {
          ...livePreview,
          role: 'current',
          eyebrow: 'Read now',
        }
      : buildEmptyReaderSlot('current', { sourceLabel, targetLabel });

  const previewSlot = previewWindow
    ? {
        ...previewWindow,
        role: 'preview',
        eyebrow: 'Incoming',
      }
    : buildEmptyReaderSlot('preview', { sourceLabel, targetLabel });

  const historyBrowsing = !state.transcriptPinnedToBottom && Boolean(elements.transcriptHistoryDetails?.open);
  const bandStatus = historyBrowsing ? 'History open' : state.settings.autoScroll ? 'Following live' : 'Manual follow';
  const idle = !state.currentSession || (!state.currentSegments.length && !liveDraft.visible);

  elements.transcriptLiveBand.classList.toggle('transcript-live-band--idle', idle);
  elements.transcriptLiveBand.innerHTML = `
    <div class="transcript-live-band__meta">
      <div class="transcript-live-band__meta-group">
        <span class="transcript-live-band__badge">${escapeHtml(bandStatus)}</span>
        <span class="transcript-live-band__timestamp">${escapeHtml(liveDraft.timestamp || 'Live')}</span>
      </div>
    </div>
    <div class="transcript-window">
      ${renderTranscriptWindowSlot(previousSlot)}
      ${renderTranscriptWindowSlot(currentSlot)}
      ${renderTranscriptWindowSlot(previewSlot)}
    </div>
  `;
}

function renderTranscriptFeedPair(row, { live = false, showPendingNote = false } = {}) {
  const mode = TRANSCRIPT_VIEW_MODES.has(state.liveTranscriptView) ? state.liveTranscriptView : 'both';
  const showSource = mode !== 'target';
  const showTarget = mode !== 'source';
  const showTargetParagraph = showTarget && !row.targetPending && row.targetText;
  const pendingNote = showTarget && row.targetPending && showPendingNote ? `${row.targetLabel || 'Translation'} catching up…` : '';
  const speakerMeta = row.title
    ? `<span class="transcript-pair__speaker-name">${escapeHtml(row.title)}</span><span class="transcript-pair__meta-sep">·</span>`
    : '';

  return `
    <article class="transcript-pair ${live ? 'transcript-pair--live' : 'transcript-pair--final'}" data-segment-key="${escapeHtml(
      row.key || ''
    )}" data-start-ms="${Number(row.startMs || 0)}" data-end-ms="${Number(row.endMs || row.startMs || 0)}">
      <div class="transcript-pair__meta transcript-pair__meta--feed">
        ${speakerMeta}
        <span class="transcript-pair__time">${escapeHtml(row.timestamp || 'Live')}</span>
      </div>
      ${
        showSource
          ? renderTranscriptParagraph({
              kind: 'source',
              label: '',
              text: row.sourceText || 'Listening…',
            })
          : ''
      }
      ${
        showTargetParagraph
          ? renderTranscriptParagraph({
              kind: 'target',
              label: '',
              text: row.targetText,
              pending: false,
            })
          : ''
      }
      ${pendingNote ? `<p class="transcript-pair__pending-note">${escapeHtml(pendingNote)}</p>` : ''}
    </article>
  `;
}

function mergeTranscriptFeedText(existingText = '', incomingText = '') {
  const left = String(existingText || '').trim();
  const right = String(incomingText || '').trim();
  if (!left) return right;
  if (!right) return left;

  const normalizedLeft = normalizeTranscript(left);
  const normalizedRight = normalizeTranscript(right);
  if (normalizedLeft && normalizedRight) {
    if (normalizedLeft === normalizedRight) {
      return right.length >= left.length ? right : left;
    }
    if (normalizedLeft.includes(normalizedRight)) {
      return left;
    }
    if (normalizedRight.includes(normalizedLeft)) {
      return right;
    }
  }

  const leftWords = left.split(/\s+/).filter(Boolean);
  const rightWords = right.split(/\s+/).filter(Boolean);
  const maxOverlap = Math.min(leftWords.length, rightWords.length, 12);
  for (let size = maxOverlap; size >= 3; size -= 1) {
    const leftTail = normalizeTranscript(leftWords.slice(-size).join(' '));
    const rightHead = normalizeTranscript(rightWords.slice(0, size).join(' '));
    if (leftTail && leftTail === rightHead) {
      const rightRemainder = rightWords.slice(size).join(' ').trim();
      if (!rightRemainder) return left;
      return `${left}${/[\s([{“"']$/.test(left) ? '' : ' '}${rightRemainder}`.trim();
    }
  }

  const lastChar = left.slice(-1);
  const firstChar = right.charAt(0);
  const needsSpace = !/\s/.test(lastChar) && !/[([{“"'/-]/.test(lastChar) && !/[,.!?;:)}\]]/.test(firstChar);
  return `${left}${needsSpace ? ' ' : ''}${right}`.replace(/\s+/g, ' ').trim();
}

function transcriptRowsOverlap(previousText = '', nextText = '') {
  const previousNormalized = normalizeTranscript(previousText);
  const nextNormalized = normalizeTranscript(nextText);
  if (!previousNormalized || !nextNormalized) return false;
  return (
    previousNormalized === nextNormalized ||
    previousNormalized.includes(nextNormalized) ||
    nextNormalized.includes(previousNormalized)
  );
}

function transcriptTextEndsSentence(text = '') {
  return /[.!?…]["')\]]*\s*$/.test(String(text || '').trim());
}

function countTranscriptSentences(text = '') {
  const matches = String(text || '').trim().match(/[.!?…](?:["')\]]+)?(?=\s|$)/g);
  return matches ? matches.length : 0;
}

function normalizeTranscriptSpeakerKey(label = '') {
  return String(label || '').trim().toLowerCase();
}

function shouldMergeTranscriptFeedRows(previousRow, nextRow, previousSegment, nextSegment) {
  if (!previousRow || !nextRow || !previousSegment || !nextSegment) return false;

  const previousSource = String(previousRow.sourceText || '').trim();
  const nextSource = String(nextRow.sourceText || '').trim();
  if (!previousSource || !nextSource) return false;

  const previousSpeakerKey = previousRow.speakerKey || normalizeTranscriptSpeakerKey(previousSegment.speakerLabel || previousSegment.speakerRawLabel || '');
  const nextSpeakerKey = nextRow.speakerKey || normalizeTranscriptSpeakerKey(nextSegment.speakerLabel || nextSegment.speakerRawLabel || '');
  if (previousSpeakerKey && nextSpeakerKey && previousSpeakerKey !== nextSpeakerKey) {
    return false;
  }

  const gapMs = Math.max(0, (nextSegment.startMs ?? previousSegment.endMs ?? 0) - (previousSegment.endMs ?? 0));
  const rowStartMs =
    previousRow.firstSegment?.startMs ??
    previousRow.firstSegment?.endMs ??
    previousSegment.startMs ??
    previousSegment.endMs ??
    0;
  const nextEndMs = nextSegment.endMs ?? nextSegment.startMs ?? rowStartMs;
  const nextTotalDurationMs = Math.max(0, nextEndMs - rowStartMs);
  if (nextTotalDurationMs > DISPLAY_ROW_MAX_MS) {
    return false;
  }

  const previousWordCount = previousSource.split(/\s+/).filter(Boolean).length;
  const nextWordCount = nextSource.split(/\s+/).filter(Boolean).length;
  const nextIsShortFragment = nextWordCount <= 4 || nextSource.length < 20;
  const previousIsShort = previousWordCount <= 6 || previousSource.length < 36;
  const previousEndsSentence = transcriptTextEndsSentence(previousSource);
  const mergedSource = mergeTranscriptFeedText(previousSource, nextSource);
  const mergedSentenceCount = countTranscriptSentences(mergedSource);
  const bothPending = previousRow.targetPending && nextRow.targetPending;
  const overlappingText = transcriptRowsOverlap(previousSource, nextSource);

  if (overlappingText) {
    return true;
  }

  if (gapMs > DISPLAY_ROW_MAX_GAP_MS && previousEndsSentence) {
    return false;
  }

  if (!previousEndsSentence) {
    return true;
  }

  if (nextIsShortFragment) {
    return true;
  }

  if (bothPending && nextTotalDurationMs <= DISPLAY_ROW_TARGET_MS) {
    return true;
  }

  if (previousIsShort && mergedSentenceCount <= DISPLAY_ROW_MAX_SENTENCE_COUNT && nextTotalDurationMs <= DISPLAY_ROW_TARGET_MS) {
    return true;
  }

  return mergedSentenceCount <= 1 && nextTotalDurationMs <= DISPLAY_ROW_TARGET_MS;
}

function buildTranscriptFeedRows(sourceLabel, targetLabel) {
  const rows = [];

  state.currentSegments.forEach((segment) => {
    const nextRow = buildTranscriptDisplayItemFromSegment(segment, { sourceLabel, targetLabel });
    const lastRow = rows[rows.length - 1];

    if (lastRow && shouldMergeTranscriptFeedRows(lastRow, nextRow, lastRow.lastSegment, segment)) {
      lastRow.key = `${lastRow.key}|${nextRow.key}`;
      if ((!lastRow.speakerKey || lastRow.title === 'Speaker') && nextRow.speakerKey && nextRow.title) {
        lastRow.title = nextRow.title;
        lastRow.speakerKey = nextRow.speakerKey;
      }
      lastRow.sourceText = mergeTranscriptFeedText(lastRow.sourceText, nextRow.sourceText);
      lastRow.targetText = mergeTranscriptFeedText(lastRow.targetText, nextRow.targetText);
      lastRow.targetPending = !lastRow.targetText && (lastRow.targetPending || nextRow.targetPending);
      lastRow.endMs = Number(segment.endMs || segment.startMs || lastRow.endMs || lastRow.startMs || 0);
      lastRow.lastSegment = segment;
      return;
    }

    rows.push({
      ...nextRow,
      firstSegment: segment,
      lastSegment: segment,
    });
  });

  return rows;
}

function mergeLiveRowIntoFeedRows(rows, liveRow) {
  if (!liveRow || !rows.length) {
    return { rows, liveRow, mergedIntoLastRow: false };
  }

  const lastRow = rows[rows.length - 1];
  const liveSource = normalizeTranscript(liveRow.sourceText || '');
  const lastSource = normalizeTranscript(lastRow.sourceText || '');
  const sameSource =
    !liveSource ||
    !lastSource ||
    liveSource === lastSource ||
    liveSource.startsWith(lastSource) ||
    lastSource.startsWith(liveSource) ||
    transcriptRowsOverlap(lastRow.sourceText || '', liveRow.sourceText || '');

  if (!sameSource) {
    return { rows, liveRow, mergedIntoLastRow: false };
  }

  const nextRows = [...rows];
  nextRows[nextRows.length - 1] = {
    ...lastRow,
    sourceText: liveRow.sourceText || lastRow.sourceText,
    targetText: liveRow.targetText || lastRow.targetText,
    targetPending: liveRow.targetPending,
    timestamp: liveRow.timestamp || lastRow.timestamp,
  };

  return { rows: nextRows, liveRow: null, mergedIntoLastRow: true };
}

function renderTranscriptHistory() {
  const list = elements.transcriptList;
  if (!list) return;

  const liveDraft = buildLiveTranscriptState();
  const sourceLabel = liveDraft.sourceLabel;
  const targetLabel = liveDraft.targetLabel;
  const shouldFollow = Boolean(state.settings.autoScroll && state.transcriptPinnedToBottom);
  const previousScrollTop = list.scrollTop;

  const feedRows = buildTranscriptFeedRows(sourceLabel, targetLabel);
  const liveRow = buildTranscriptDisplayItemFromLiveDraft(liveDraft);
  const { rows: mergedRows, liveRow: appendedLiveRow, mergedIntoLastRow } = mergeLiveRowIntoFeedRows(feedRows, liveRow);

  if (!mergedRows.length && !appendedLiveRow) {
    list.innerHTML = `<div class="transcript-empty">${escapeHtml(
      state.currentSession
        ? 'Transcript lines will appear here as speech is captured and translated.'
        : 'Listen in one language and read in another. Start a session to begin.'
    )}</div>`;
  } else {
    const rowMarkup = mergedRows
      .map((row, index) => {
        const isNewestMergedRow = mergedIntoLastRow && index === mergedRows.length - 1;
        return renderTranscriptFeedPair(row, {
          live: isNewestMergedRow,
          showPendingNote: false,
        });
      })
      .join('');

    list.innerHTML = `${rowMarkup}${appendedLiveRow ? renderTranscriptFeedPair(appendedLiveRow, { live: true, showPendingNote: false }) : ''}`;
  }

  requestAnimationFrame(() => {
    if (shouldFollow) {
      const targetTop = getTranscriptFollowTargetTop(list);
      list.scrollTop = targetTop;
    } else {
      list.scrollTop = previousScrollTop;
    }
    updateTranscriptAutoFollowState();
    updatePlaybackHighlight();
  });
}

function renderTranscript() {
  renderTranscriptHistory();
}

function ensureReviewAudioPlaybackDefaults() {
  const audio = elements.reviewAudio;
  if (!audio) return;
  if (audio.defaultPlaybackRate !== 1) audio.defaultPlaybackRate = 1;
  if (audio.playbackRate !== 1) audio.playbackRate = 1;
}

function isReviewAudioPlaying() {
  return Boolean(
    elements.reviewAudio && !elements.reviewAudio.paused && !elements.reviewAudio.ended && state.sessionPlaybackPreviewMs === null
  );
}

function getCurrentPlaybackAbsoluteMs() {
  const audio = elements.reviewAudio;
  const recording = state.sessionRecordings[state.sessionPlaybackClipIndex];
  if (!audio || !recording) return null;
  return Number(recording.startMs || 0) + Math.round((audio.currentTime || 0) * 1000);
}

function updateSpeakerPlaybackIndicator() {
  const currentPlaybackSegment = state.currentSegments.find((segment) => segment.id === state.sessionPlaybackSegmentId);
  const activeSpeakerKey = currentPlaybackSegment ? getSpeakerSummaryKeyForSegment(currentPlaybackSegment) : '';

  Array.from(elements.speakerSummary?.querySelectorAll('.speaker-stat[data-speaker-key]') || []).forEach((card) => {
    card.classList.toggle('speaker-stat--playing', Boolean(activeSpeakerKey) && card.dataset.speakerKey === activeSpeakerKey);
  });

  Array.from(elements.speakerSummary?.querySelectorAll('.speaker-stat__icon-button[data-speaker-key]') || []).forEach((button) => {
    button.classList.toggle('speaker-stat__icon-button--active', Boolean(activeSpeakerKey) && button.dataset.speakerKey === activeSpeakerKey);
  });
}

function resetSessionPlaybackState() {
  const audio = elements.reviewAudio;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  if (state.sessionPlaybackObjectUrl) {
    URL.revokeObjectURL(state.sessionPlaybackObjectUrl);
  }
  state.sessionPlaybackClipIndex = -1;
  state.sessionPlaybackObjectUrl = '';
  state.sessionPlaybackSegmentId = '';
  state.sessionPlaybackPreviewMs = null;
  state.reviewAudioFloatingActive = false;
}

function updatePlaybackHighlight({ shouldScroll = false, forceScroll = false } = {}) {
  const absoluteMs = getCurrentPlaybackAbsoluteMs();
  const rows = Array.from(elements.transcriptList?.querySelectorAll('.transcript-pair[data-start-ms]') || []);
  const previousSegmentId = state.sessionPlaybackSegmentId;
  let activeRow = null;
  rows.forEach((row) => {
    const startMs = Number(row.dataset.startMs || 0);
    const endMs = Number(row.dataset.endMs || startMs);
    const active = absoluteMs !== null && absoluteMs >= startMs && absoluteMs <= endMs + 400;
    row.classList.toggle('transcript-pair--playing', active);
    if (active) activeRow = row;
  });
  state.sessionPlaybackSegmentId = activeRow?.dataset.segmentKey || '';
  if (activeRow && shouldScroll && state.sessionPlaybackAutoScroll && (forceScroll || state.sessionPlaybackSegmentId !== previousSegmentId)) {
    activeRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  if (state.sessionPlaybackSegmentId !== previousSegmentId) {
    updateSpeakerPlaybackIndicator();
  }
}

function findRecordingIndexForTime(absoluteMs) {
  const targetMs = Number(absoluteMs || 0);
  const exactIndex = state.sessionRecordings.findIndex((recording) => {
    if (!hasRecordingBlob(recording)) return false;
    const startMs = Number(recording.startMs || 0);
    const endMs = Number(recording.endMs || startMs);
    return targetMs >= startMs && targetMs <= endMs + 300;
  });

  if (exactIndex !== -1) return exactIndex;

  let fallbackIndex = -1;
  state.sessionRecordings.forEach((recording, index) => {
    if (!hasRecordingBlob(recording)) return;
    if (targetMs >= Number(recording.startMs || 0)) {
      fallbackIndex = index;
    }
  });

  if (fallbackIndex !== -1) return fallbackIndex;

  return state.sessionRecordings.findIndex((recording) => hasRecordingBlob(recording));
}

async function loadRecordingClip(index, { autoplay = false, seekMs = null, forceScroll = false, userGesture = false } = {}) {
  const audio = elements.reviewAudio;
  const recording = state.sessionRecordings[index];
  if (!audio || !recording?.blob) return false;
  ensureReviewAudioPlaybackDefaults();
  state.sessionPlaybackPreviewMs = null;
  if (state.sessionPlaybackClipIndex === index && audio.src) {
    if (seekMs !== null) {
      audio.currentTime = Math.max(0, recordingTimeToLocalOffset(recording, seekMs) / 1000);
    }
    renderRecordingReview();
    if (autoplay) {
      await audio.play().catch(() => {});
    }
    updatePlaybackHighlight({ shouldScroll: true, forceScroll });
    return true;
  }
  if (state.sessionPlaybackObjectUrl) {
    URL.revokeObjectURL(state.sessionPlaybackObjectUrl);
  }
  const objectUrl = URL.createObjectURL(recording.blob);
  state.sessionPlaybackObjectUrl = objectUrl;
  state.sessionPlaybackClipIndex = index;
  audio.src = objectUrl;
  audio.load();

  if (autoplay && userGesture) {
    try {
      const playAttempt = audio.play();
      if (playAttempt && typeof playAttempt.catch === 'function') {
        playAttempt.catch(() => {});
      }
    } catch {
      // ignore user-gesture priming failures
    }
  }

  await new Promise((resolve) => {
    audio.addEventListener('loadedmetadata', resolve, { once: true });
  }).catch(() => {});
  ensureReviewAudioPlaybackDefaults();
  if (seekMs !== null) {
    audio.currentTime = Math.max(0, recordingTimeToLocalOffset(recording, seekMs) / 1000);
  }
  renderRecordingReview();
  updatePlaybackHighlight({ shouldScroll: true, forceScroll });
  if (autoplay) {
    try {
      await audio.play();
    } catch {
      // ignore autoplay rejection
    }
  }
  return true;
}

async function playSessionAudioAtMs(absoluteMs, { autoplay = true, userGesture = false } = {}) {
  const targetMs = clampSessionPlaybackMs(absoluteMs);
  const clipIndex = findRecordingIndexForTime(targetMs);
  if (clipIndex === -1) return false;
  return loadRecordingClip(clipIndex, { autoplay, seekMs: targetMs, forceScroll: true, userGesture });
}

function primeReviewAudioPlaybackForUserGesture(targetMs = null) {
  const audio = elements.reviewAudio;
  if (!audio) return false;

  const desiredMs = targetMs === null ? null : clampSessionPlaybackMs(targetMs);
  const clipIndex = desiredMs === null ? state.sessionPlaybackClipIndex : findRecordingIndexForTime(desiredMs);
  if (clipIndex === -1) return false;

  if (state.sessionPlaybackClipIndex === clipIndex && audio.src && desiredMs !== null) {
    const recording = state.sessionRecordings[clipIndex];
    if (recording) {
      try {
        audio.currentTime = Math.max(0, recordingTimeToLocalOffset(recording, desiredMs) / 1000);
      } catch {
        // ignore seek priming errors
      }
    }
  }

  try {
    const playAttempt = audio.play();
    if (playAttempt && typeof playAttempt.catch === 'function') {
      playAttempt.catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

function setSessionPlaybackPreviewMs(absoluteMs) {
  if (absoluteMs === null || absoluteMs === undefined || Number.isNaN(Number(absoluteMs))) {
    state.sessionPlaybackPreviewMs = null;
  } else {
    state.sessionPlaybackPreviewMs = clampSessionPlaybackMs(absoluteMs);
  }
  renderRecordingReview();
}

async function seekSessionAudioToMs(absoluteMs, { autoplay = null, forceScroll = true, userGesture = false } = {}) {
  const targetMs = clampSessionPlaybackMs(absoluteMs);
  const shouldAutoplay = autoplay === null ? true : Boolean(autoplay);
  state.sessionPlaybackPreviewMs = null;
  const played = await playSessionAudioAtMs(targetMs, { autoplay: shouldAutoplay, userGesture });
  if (!played) return false;
  renderRecordingReview();
  updatePlaybackHighlight({ shouldScroll: true, forceScroll });
  return true;
}

async function seekSessionAudioByDeltaMs(deltaMs, { autoplay = true, userGesture = false } = {}) {
  const currentPlaybackMs = getVisibleSessionPlaybackMs();
  const baseMs = currentPlaybackMs === null ? 0 : currentPlaybackMs;
  return seekSessionAudioToMs(baseMs + Number(deltaMs || 0), { autoplay, forceScroll: true, userGesture });
}

async function playReviewAudio({ userGesture = false } = {}) {
  const audio = elements.reviewAudio;
  if (!audio || !state.sessionRecordings.length) return;
  ensureReviewAudioPlaybackDefaults();
  if (state.sessionPlaybackClipIndex < 0) {
    const initialPlaybackMs = getVisibleSessionPlaybackMs() || 0;
    const initialIndex = Math.max(0, findRecordingIndexForTime(initialPlaybackMs));
    await loadRecordingClip(initialIndex, { autoplay: true, seekMs: initialPlaybackMs, forceScroll: true, userGesture });
    return;
  }
  if (audio.ended && state.sessionPlaybackClipIndex >= state.sessionRecordings.length - 1) {
    await loadRecordingClip(0, { autoplay: true, seekMs: 0, forceScroll: true, userGesture });
    return;
  }
  await audio.play().catch(() => {});
}

async function pauseReviewAudio() {
  state.reviewAudioFloatingActive = false;
  elements.reviewAudio?.pause();
  renderRecordingReview();
}

async function stopReviewAudio({ resetToStart = true } = {}) {
  const audio = elements.reviewAudio;
  audio?.pause();
  state.reviewAudioFloatingActive = false;
  state.sessionPlaybackSegmentId = '';
  state.sessionPlaybackPreviewMs = null;

  if (resetToStart) {
    const firstClipIndex = findRecordingIndexForTime(0);
    if (firstClipIndex !== -1) {
      await loadRecordingClip(firstClipIndex, { autoplay: false, seekMs: 0, forceScroll: false });
      audio?.pause();
    } else {
      resetSessionPlaybackState();
      state.sessionPlaybackPreviewMs = 0;
    }
  }

  renderRecordingReview();
  updatePlaybackHighlight();
}

async function toggleReviewAudioPlayback() {
  if (isReviewAudioPlaying()) {
    await pauseReviewAudio();
    return;
  }

  await playReviewAudio({ userGesture: true });
}

function commitReviewAudioSeekFromControl({ userGesture = false } = {}) {
  const nextValue = Number(elements.reviewProgressInput?.value || 0);
  return seekSessionAudioToMs(nextValue, { autoplay: true, forceScroll: true, userGesture });
}

function renderRecordingReview() {
  const count = state.sessionRecordings.length;
  const durationMs = getSessionRecordingDurationMs();
  const undiarized = state.sessionRecordings.filter((recording) => !recording.diarizedAt).length;
  const currentIndex = state.sessionPlaybackClipIndex;
  const currentClip = currentIndex >= 0 ? state.sessionRecordings[currentIndex] : null;
  const currentPlaybackMs = getVisibleSessionPlaybackMs();
  const playing = isReviewAudioPlaying();
  const floatingPlayback = count > 0 && (playing || state.reviewAudioFloatingActive);

  if (!count) {
    state.reviewAudioFloatingActive = false;
  }

  if (typeof document !== 'undefined' && document.body) {
    document.body.dataset.reviewAudioFloating = floatingPlayback ? 'true' : 'false';
  }

  if (elements.reviewAudioStatus) {
    const parts = [];
    if (count) parts.push(`${count} clip${count === 1 ? '' : 's'} saved locally`);
    if (durationMs) parts.push(`${formatDuration(durationMs)} recorded`);
    if (undiarized) parts.push(`${undiarized} clip${undiarized === 1 ? '' : 's'} ready for speaker finalize`);
    if (currentPlaybackMs !== null && durationMs) {
      parts.push(`${playing ? 'Playing' : 'Ready at'} ${formatDuration(currentPlaybackMs)} of ${formatDuration(durationMs)}`);
    }
    if (state.wakeLockMessage) parts.push(state.wakeLockMessage);
    elements.reviewAudioStatus.textContent = parts.join(' • ') || 'Local session recording will appear here while capture runs.';
  }

  if (elements.reviewPlayPauseButton) {
    elements.reviewPlayPauseButton.disabled = !count;
    elements.reviewPlayPauseButton.dataset.state = playing ? 'pause' : 'play';
    elements.reviewPlayPauseButton.textContent = playing ? '❚❚' : '▶';
    elements.reviewPlayPauseButton.setAttribute('aria-label', playing ? 'Pause whole session audio' : 'Play whole session audio');
    elements.reviewPlayPauseButton.title = playing ? 'Pause whole session audio' : 'Play whole session audio';
  }
  if (elements.reviewStopButton) {
    const canStop = Boolean(count) && (playing || state.reviewAudioFloatingActive || (currentPlaybackMs || 0) > 0 || currentIndex > 0);
    elements.reviewStopButton.disabled = !canStop;
  }
  if (elements.reviewAudioTransport) {
    elements.reviewAudioTransport.classList.toggle('hidden', !count);
    elements.reviewAudioTransport.classList.toggle('review-audio-transport--floating', floatingPlayback && count > 0);
  }
  syncReviewAudioTransportMount({ floatingPlayback: floatingPlayback && count > 0 });
  if (elements.reviewAudio) {
    elements.reviewAudio.classList.add('hidden');
    elements.reviewAudio.dataset.clipLabel = currentClip ? `${formatDurationShort(currentClip.startMs || 0)}-${formatDurationShort(currentClip.endMs || 0)}` : '';
  }

  if (elements.reviewCurrentTime) {
    elements.reviewCurrentTime.textContent = formatDuration(currentPlaybackMs || 0);
  }
  if (elements.reviewTotalTime) {
    elements.reviewTotalTime.textContent = formatDuration(durationMs || 0);
  }
  if (elements.reviewProgressInput) {
    elements.reviewProgressInput.max = String(durationMs || 0);
    elements.reviewProgressInput.value = String(currentPlaybackMs || 0);
    elements.reviewProgressInput.disabled = !count || durationMs <= 0;
    setReviewProgressVisual(currentPlaybackMs || 0, durationMs || 0);
  }

  const canSeekBackward30 = count && (currentPlaybackMs || 0) > 0;
  const canSeekForward30 = count && durationMs > 0 && (currentPlaybackMs || 0) < durationMs;
  if (elements.reviewJumpBack5mButton) {
    elements.reviewJumpBack5mButton.disabled = !count || (currentPlaybackMs || 0) <= 0;
  }
  if (elements.reviewJumpBack30Button) {
    elements.reviewJumpBack30Button.disabled = !canSeekBackward30;
  }
  if (elements.reviewJumpForward30Button) {
    elements.reviewJumpForward30Button.disabled = !canSeekForward30;
  }
  if (elements.reviewJumpForward5mButton) {
    elements.reviewJumpForward5mButton.disabled = !count || durationMs <= 0 || (currentPlaybackMs || 0) >= durationMs;
  }

  if (count && state.sessionPlaybackClipIndex === -1) {
    const initialPlaybackMs = currentPlaybackMs === null ? 0 : currentPlaybackMs;
    const initialIndex = Math.max(0, findRecordingIndexForTime(initialPlaybackMs));
    loadRecordingClip(initialIndex, { seekMs: initialPlaybackMs }).catch(() => {});
  }
}

function buildManualSpeakerRowsForDisplay() {
  const segments = getManualSpeakerEventsForSession(state.currentSession);
  let runningTotalMs = 0;
  const eventRows = segments
    .map((segment, index) => {
      const durationMs = Math.max(0, Number(segment.endMs || 0) - Number(segment.startMs || 0));
      runningTotalMs += durationMs;
      return {
        ...segment,
        id: getManualSpeakerEntryId(segment, index),
        speakerLabel: String(segment.speakerLabel || '').trim() || 'Speaker',
        changeMs: durationMs,
        overallMs: runningTotalMs,
        playMs: Math.max(0, Number(segment.startMs || 0)),
        displayMode: 'segment',
        isBaseline: false,
      };
    })
    .filter((segment) => segment.changeMs > 0);

  return {
    headings: ['Speaker', 'Change', 'Overall'],
    rows: eventRows,
    emptyMessage: isManualSpeakerTimerRunning()
      ? 'Speaker timing is running. Tap 👥 when the speaker changes.'
      : 'No speaker marks yet. Tap Resume to start, then use 👥 when the speaker changes.',
  };
}

function renderManualSpeakerControls() {
  if (!elements.speakerChangeTimer) return;
  const options = getSpeakerOptionsForManualControls();
  const currentLabel = state.manualSpeakerCurrentLabel || options[0] || 'Speaker A';
  const timerRunning = isManualSpeakerTimerRunning();
  const manualRows = buildManualSpeakerRowsForDisplay();
  const activeLabel = normalizeManualSpeakerName(state.manualSpeakerActiveLabel || currentLabel || options[0] || 'Speaker A');
  const hasPendingSpeakerChange = Boolean(timerRunning && normalizeManualSpeakerName(currentLabel) && normalizeManualSpeakerName(currentLabel) !== activeLabel);

  state.manualSpeakerCurrentLabel = currentLabel;
  elements.speakerChangeDock?.setAttribute('data-manual-speaker-state', timerRunning ? 'running' : 'paused');
  elements.speakerChangeTimer.textContent = formatManualStopwatchTime(getManualSpeakerElapsedMs());
  if (elements.speakerChangeTimerState) {
    elements.speakerChangeTimerState.textContent = timerRunning
      ? `${activeLabel} live`
      : state.currentSession?.status === 'ended'
        ? 'Session ended'
        : state.currentSession?.status === 'active' || state.runtimeStatus === 'stopped' || state.currentSession?.status === 'paused'
          ? 'Stopped'
          : 'Ready';
  }
  if (elements.speakerChangeCurrentLabel) {
    elements.speakerChangeCurrentLabel.textContent = hasPendingSpeakerChange ? 'Next speaker on Mark' : 'Current speaker';
  }
  if (elements.speakerChangeCurrentSelect) {
    elements.speakerChangeCurrentSelect.innerHTML = options
      .map((label) => `<option value="${escapeHtml(label)}" ${label === currentLabel ? 'selected' : ''}>${escapeHtml(label)}</option>`)
      .join('');
    elements.speakerChangeCurrentSelect.setAttribute('aria-label', hasPendingSpeakerChange ? 'Next speaker on Mark' : 'Current speaker');
    elements.speakerChangeCurrentSelect.disabled = !state.currentSession || state.currentSession.status === 'ended';
  }
  if (elements.speakerChangePendingHint) {
    elements.speakerChangePendingHint.textContent = hasPendingSpeakerChange
      ? `Live now: ${activeLabel}. Mark will switch to ${currentLabel}.`
      : timerRunning
        ? ''
        : 'Choose the speaker you want active when timing resumes.';
  }
  if (elements.speakerChangeCustomInput) {
    if (document.activeElement !== elements.speakerChangeCustomInput || elements.speakerChangeCustomInput.value !== state.manualSpeakerCustomNameDraft) {
      elements.speakerChangeCustomInput.value = state.manualSpeakerCustomNameDraft;
    }
    elements.speakerChangeCustomInput.disabled = !state.currentSession || state.currentSession.status === 'ended';
  }
  if (elements.speakerChangeCustomUseButton) {
    elements.speakerChangeCustomUseButton.disabled =
      !state.currentSession ||
      state.currentSession.status === 'ended' ||
      !normalizeManualSpeakerName(state.manualSpeakerCustomNameDraft);
  }
  if (elements.speakerChangeButton) {
    elements.speakerChangeButton.textContent = timerRunning ? '👥 Mark' : 'Reset';
    elements.speakerChangeButton.disabled = timerRunning
      ? !state.currentSession || state.currentSession.status === 'ended'
      : !state.currentSession || (manualRows.rows.length === 0 && getManualSpeakerElapsedMs() === 0);
    elements.speakerChangeButton.dataset.mode = timerRunning ? 'mark' : 'reset';
    elements.speakerChangeButton.classList.toggle('speaker-change-action--mark', timerRunning);
    elements.speakerChangeButton.classList.toggle('speaker-change-action--reset', !timerRunning);
  }
  if (elements.speakerChangePauseButton) {
    elements.speakerChangePauseButton.textContent = timerRunning ? 'Stop' : 'Resume';
    elements.speakerChangePauseButton.disabled =
      !state.currentSession || state.currentSession.status === 'ended' || (!timerRunning && state.currentSession.status !== 'active');
    elements.speakerChangePauseButton.dataset.mode = timerRunning ? 'stop' : 'resume';
    elements.speakerChangePauseButton.classList.toggle('speaker-change-action--stop', timerRunning);
    elements.speakerChangePauseButton.classList.toggle('speaker-change-action--resume', !timerRunning);
  }
  if (elements.speakerChangeMarkers) {
    if (!manualRows.rows.length) {
      elements.speakerChangeMarkers.innerHTML = `<div class="speaker-change-marker-empty">${escapeHtml(manualRows.emptyMessage)}</div>`;
    } else {
      elements.speakerChangeMarkers.innerHTML = [
        `<div class="speaker-change-marker-headings"><span>${escapeHtml(manualRows.headings[0])}</span><span>${escapeHtml(
          manualRows.headings[1]
        )}</span><span>${escapeHtml(manualRows.headings[2])}</span></div>`,
        manualRows.rows
          .map(
            (row) => `
              <div class="speaker-change-marker-row ${state.manualSpeakerEditingEventId === row.id ? 'speaker-change-marker-row--editing' : ''}">
                <button
                  class="speaker-change-marker-row__speaker-button"
                  type="button"
                  data-speaker-marker-toggle-id="${escapeHtml(row.id)}"
                  aria-expanded="${state.manualSpeakerEditingEventId === row.id ? 'true' : 'false'}"
                  aria-label="Change speaker for ${escapeHtml(row.speakerLabel || 'speaker')}"
                >
                  <span class="speaker-change-marker-row__speaker">${escapeHtml(row.speakerLabel || 'Speaker')}</span>
                  <span class="speaker-change-marker-row__speaker-chevron" aria-hidden="true">${state.manualSpeakerEditingEventId === row.id ? '▾' : '▸'}</span>
                </button>
                <span class="speaker-change-marker-row__split ${row.isBaseline ? 'speaker-change-marker-row__split--start' : ''}">${escapeHtml(
                  row.isBaseline ? 'Start' : formatManualStopwatchTime(row.changeMs || 0)
                )}</span>
                <button
                  class="speaker-change-marker-row__overall"
                  type="button"
                  data-speaker-marker-play-ms="${Number(row.playMs || 0)}"
                  aria-label="Play from ${escapeHtml(formatManualStopwatchTime(row.playMs || 0))}"
                >${escapeHtml(formatManualStopwatchTime(row.overallMs || 0))}</button>
                ${
                  state.manualSpeakerEditingEventId === row.id
                    ? `<div class="speaker-change-marker-row__editor">
                        <div class="speaker-change-marker-row__editor-options" role="group" aria-label="Choose speaker for ${escapeHtml(
                          row.speakerLabel || 'speaker'
                        )}">
                          ${options
                            .map(
                              (label) => `
                                <button
                                  class="speaker-change-marker-row__editor-option ${label === row.speakerLabel ? 'speaker-change-marker-row__editor-option--active' : ''}"
                                  type="button"
                                  data-speaker-marker-choice-id="${escapeHtml(row.id)}"
                                  data-speaker-label="${escapeHtml(label)}"
                                  aria-pressed="${label === row.speakerLabel ? 'true' : 'false'}"
                                >${escapeHtml(label)}</button>`
                            )
                            .join('')}
                        </div>
                      </div>`
                    : ''
                }
              </div>`
          )
          .join(''),
      ].join('');
    }
  }
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
      const status = session.status === 'ended' ? 'Ended' : session.status === 'paused' ? 'Stopped' : 'Active';
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

function hasSessionCaptureActivity(session = state.currentSession) {
  if (!session) return false;
  const recordings = session?.id === state.currentSession?.id ? state.sessionRecordings : [];
  return Boolean(
    Number(session.activeDurationMs || 0) > 0 ||
      Number(session.segmentCount || 0) > 0 ||
      getManualSpeakerEventsForSession(session).length > 0 ||
      recordings.some((recording) => hasRecordingBlob(recording)) ||
      ['listening', 'connecting', 'reconnecting', 'stopped', 'paused', 'error'].includes(String(session.runtimeStatus || ''))
  );
}

function renderControls() {
  const session = state.currentSession;
  const runtime = state.runtimeStatus;
  const ended = !session || session.status === 'ended';
  const hasActivity = hasSessionCaptureActivity(session);
  let primaryMode = 'start';
  let primaryLabel = 'Start';
  let primaryClassName = 'button button--primary';

  if (session && !ended) {
    if (['listening', 'connecting', 'reconnecting'].includes(runtime)) {
      primaryMode = 'stop';
      primaryLabel = 'Stop';
      primaryClassName = 'button button--danger';
    } else if (['paused', 'stopped', 'error'].includes(runtime) || (runtime === 'idle' && hasActivity)) {
      primaryMode = 'resume';
      primaryLabel = 'Resume';
    }
  }

  elements.startButton.className = primaryClassName;
  elements.startButton.textContent = primaryLabel;
  elements.startButton.dataset.mode = primaryMode;
  elements.startButton.classList.toggle('hidden', !session || ended);
  elements.pauseButton.classList.add('hidden');
  elements.resumeButton.classList.add('hidden');
  elements.stopButton.classList.add('hidden');
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
    if (debugNoPersistence) return;
    await setMeta('lastActiveSessionId', state.currentSession.id);
  } else {
    state.lastActiveSessionId = null;
    if (debugNoPersistence) return;
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
    manualSpeakerEvents: [],
    manualSpeakerOpenStartMs: null,
    manualSpeakerActiveLabel: '',
    manualSpeakerBaseOffsetMs: 0,
    manualSpeakerElapsedMs: 0,
    manualSpeakerPaused: true,
    manualSpeakerCurrentLabel: '',
    manualSpeakerPendingChangeAtMs: null,
    speakerFinalizedAt: '',
  };

  await upsertSession(session);
  return session;
}

async function loadSession(sessionId) {
  const session = await getSession(sessionId);
  if (!session) return null;
  resetSessionPlaybackState();
  state.currentSession = session;
  state.currentSegments = await listSegmentsBySession(sessionId);
  state.sessionRecordings = await listRecordingsBySession(sessionId);
  state.speechActive = false;
  state.speakerFinalizeProgress = null;
  clearLiveDraftCarry();
  state.manualSpeakerEvents = normalizeManualSpeakerSegments(session.manualSpeakerEvents, session);
  state.manualSpeakerOpenStartMs = session.manualSpeakerOpenStartMs === null || session.manualSpeakerOpenStartMs === undefined
    ? null
    : Math.max(0, Number(session.manualSpeakerOpenStartMs || 0));
  state.manualSpeakerActiveLabel = String(session.manualSpeakerActiveLabel || '').trim();
  state.manualSpeakerBaseOffsetMs = Number(session.manualSpeakerBaseOffsetMs || 0);
  state.manualSpeakerCurrentLabel = String(session.manualSpeakerCurrentLabel || '').trim();
  state.manualSpeakerPendingChangeAtMs = session.manualSpeakerPendingChangeAtMs === null ? null : Number(session.manualSpeakerPendingChangeAtMs || 0);
  state.manualSpeakerCustomNameDraft = '';
  state.manualSpeakerElapsedMs = Math.max(0, Number(session.manualSpeakerElapsedMs || 0));
  state.manualSpeakerPaused = session.manualSpeakerPaused !== false;
  state.manualSpeakerEditingEventId = '';
  state.currentSession.speakerFinalizedAt = String(session.speakerFinalizedAt || '').trim();
  state.speakerTrackingStatus = state.speakerTrackingSupported
    ? 'Speaker timing is a best-effort background feature and may lag slightly.'
    : 'This browser does not support background speaker detection.';
  state.draftByItemId.clear();
  state.commitMetaByItemId.clear();
  state.activeDraftItemId = null;
  state.transcriptPinnedToBottom = true;
  flushListeningClock();
  flushSpeechClock();
  setStatus(
    session.runtimeStatus || (session.status === 'ended' ? 'ended' : 'stopped'),
    session.status === 'ended'
      ? 'Session ended.'
      : ['paused', 'stopped'].includes(String(session.runtimeStatus || '')) || session.status === 'paused'
        ? 'Stopped. Tap Resume to continue this session.'
        : 'Session loaded.'
  );
  renderCurrentView();
  return session;
}

function renderCurrentView() {
  applySettingsToForms();
  renderSessionSummary();
  renderDrafts();
  renderSpeakerInsights();
  renderRecordingReview();
  renderManualSpeakerControls();
  renderHistory();
  renderControls();
}

async function refreshSessionRecordings(sessionId = state.currentSession?.id) {
  if (!sessionId) {
    state.sessionRecordings = [];
    return [];
  }
  const recordings = await listRecordingsBySession(sessionId);
  if (state.currentSession?.id === sessionId) {
    state.sessionRecordings = recordings;
  }
  return recordings;
}

async function persistRecordingClip({ sessionId, blob, startMs, endMs, mimeType }) {
  if (!sessionId || !blob || !blob.size || endMs <= startMs) return null;
  const recording = {
    id: crypto.randomUUID(),
    sessionId,
    kind: 'session-audio',
    startMs,
    endMs,
    durationMs: Math.max(0, endMs - startMs),
    mimeType: mimeType || blob.type || 'audio/webm',
    diarizedAt: null,
    createdAt: nowIso(),
    blob,
  };
  await upsertRecording(recording);
  if (state.currentSession?.id === sessionId) {
    state.sessionRecordings = [...state.sessionRecordings, recording].sort((a, b) => (a.startMs || 0) - (b.startMs || 0));
    renderRecordingReview();
  }
  return recording;
}

async function requestScreenWakeLock() {
  if (!state.wakeLockSupported || !state.wakeLockWanted || document.visibilityState !== 'visible') return false;
  try {
    const lock = await navigator.wakeLock.request('screen');
    state.screenWakeLock = lock;
    state.wakeLockActive = true;
    state.wakeLockMessage = 'Screen wake lock is active while capture runs.';
    lock.addEventListener('release', () => {
      if (state.screenWakeLock === lock) {
        state.screenWakeLock = null;
        state.wakeLockActive = false;
        state.wakeLockMessage = state.wakeLockWanted
          ? 'The browser released the wake lock. Transcripto will try again when the page is visible.'
          : '';
        renderRecordingReview();
      }
    });
    renderRecordingReview();
    return true;
  } catch (error) {
    state.wakeLockActive = false;
    state.wakeLockMessage = 'This browser would not keep the screen awake. Capture and playback should still continue when possible.';
    renderRecordingReview();
    console.warn('Screen wake lock request failed', error);
    return false;
  }
}

async function releaseScreenWakeLock() {
  state.wakeLockWanted = false;
  const lock = state.screenWakeLock;
  state.screenWakeLock = null;
  state.wakeLockActive = false;
  if (lock) {
    try {
      await lock.release();
    } catch {
      // ignore
    }
  }
  renderRecordingReview();
}

async function ensureScreenWakeLock(enabled) {
  state.wakeLockWanted = Boolean(enabled);
  if (enabled) {
    await requestScreenWakeLock();
    return;
  }
  await releaseScreenWakeLock();
}

async function runDiarizeAudioChunk(request) {
  if (typeof state.debugDiarizeAudioChunk === 'function') {
    return state.debugDiarizeAudioChunk(request);
  }
  return diarizeAudioChunk(request);
}

async function markRecordingsAsDiarized(recordings = [], diarizedAt = nowIso()) {
  if (!recordings.length) return;
  const updatedIds = new Set();

  for (const recording of recordings) {
    if (!recording?.id) continue;
    const updatedRecording = {
      ...recording,
      diarizedAt,
    };
    await upsertRecording(updatedRecording);
    updatedIds.add(String(updatedRecording.id));
  }

  if (updatedIds.size && state.currentSession) {
    state.sessionRecordings = state.sessionRecordings.map((item) => {
      if (!updatedIds.has(String(item.id))) return item;
      return {
        ...item,
        diarizedAt,
      };
    });
  }
}

async function applyDiarizedRecordingPass(
  { audioBlob, filename, chunkStartMs, chunkEndMs, diarizedSegments, recordings = [], force = false },
  session = state.currentSession
) {
  if (!audioBlob || !session) return 0;
  const diarized = diarizedSegments
    ? { segments: diarizedSegments }
    : await runDiarizeAudioChunk({
        apiKey: state.settings.apiKey,
        audioBlob,
        filename,
        language: session.sourceLanguage,
      });

  const applied = await applySpeakerLabelsFromDiarizedChunk({
    sessionId: session.id,
    chunkStartMs: Number(chunkStartMs || 0),
    chunkEndMs: Number(chunkEndMs || chunkStartMs || 0),
    diarizedSegments: diarized.segments,
    force,
  });

  await markRecordingsAsDiarized(recordings);
  return applied;
}

function getRecordingDiarizeFilename(recording) {
  const extension = recording?.mimeType?.includes('mp4') ? 'm4a' : recording?.mimeType?.includes('ogg') ? 'ogg' : 'webm';
  return `session-recording-${recording?.startMs}.${extension}`;
}

async function normalizeRecordingClipForFinalSpeakerPass(recording) {
  if (!recording?.blob) {
    return {
      audioBlob: null,
      filename: getRecordingDiarizeFilename(recording),
      normalized: false,
    };
  }

  try {
    const wavBlob = await mergeRecordingBatchToWav([recording]);
    if (wavBlob?.size) {
      return {
        audioBlob: wavBlob,
        filename: `session-recording-${recording.startMs}.wav`,
        normalized: true,
      };
    }
  } catch (error) {
    console.warn('Unable to normalize saved speaker clip to WAV before diarization', error);
  }

  return {
    audioBlob: recording.blob,
    filename: getRecordingDiarizeFilename(recording),
    normalized: false,
  };
}

async function diarizeRecordingClip(recording, session = state.currentSession) {
  if (!recording?.blob || !session) return 0;
  const prepared = await normalizeRecordingClipForFinalSpeakerPass(recording);
  return applyDiarizedRecordingPass(
    {
      audioBlob: prepared.audioBlob,
      filename: prepared.filename,
      chunkStartMs: Number(recording.startMs || 0),
      chunkEndMs: Number(recording.endMs || recording.startMs || 0),
      recordings: [recording],
    },
    session
  );
}

function getSpeakerFinalizeAudioContextClass() {
  return window.AudioContext || window.webkitAudioContext || null;
}

function createMonoWavBlob(samples, sampleRate) {
  const length = samples.length;
  const wavBuffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(wavBuffer);
  const writeString = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, length * 2, true);

  let offset = 44;
  for (let index = 0; index < length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] || 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return new Blob([wavBuffer], { type: 'audio/wav' });
}

async function mergeRecordingBatchToWav(recordings = []) {
  if (!recordings.length) throw new Error('No session recordings available for final speaker timing.');
  const AudioContextClass = getSpeakerFinalizeAudioContextClass();
  if (!AudioContextClass) {
    throw new Error('This browser cannot merge saved audio clips for final speaker timing.');
  }

  let audioContext;
  try {
    audioContext = new AudioContextClass({ sampleRate: 16000 });
  } catch {
    audioContext = new AudioContextClass();
  }

  try {
    const decodedBuffers = [];
    for (const recording of recordings) {
      const blob = recording?.blob;
      if (!blob) continue;
      const arrayBuffer = await blob.arrayBuffer();
      const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      if (decoded?.length) {
        decodedBuffers.push(decoded);
      }
    }

    if (!decodedBuffers.length) {
      throw new Error('The saved audio clips could not be decoded for final speaker timing.');
    }

    const sampleRate = decodedBuffers[0].sampleRate || audioContext.sampleRate || 16000;
    const totalFrames = decodedBuffers.reduce((total, buffer) => total + buffer.length, 0);
    const monoSamples = new Float32Array(totalFrames);

    let writeOffset = 0;
    decodedBuffers.forEach((buffer) => {
      const channelCount = Math.max(1, Number(buffer.numberOfChannels || 1));
      const channelData = Array.from({ length: channelCount }, (_, index) => buffer.getChannelData(index));
      for (let frame = 0; frame < buffer.length; frame += 1) {
        let sample = 0;
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
          sample += channelData[channelIndex]?.[frame] || 0;
        }
        monoSamples[writeOffset + frame] = sample / channelCount;
      }
      writeOffset += buffer.length;
    });

    return createMonoWavBlob(monoSamples, sampleRate);
  } finally {
    try {
      await audioContext.close();
    } catch {
      // ignore
    }
  }
}

function buildSpeakerFinalizeBatches(recordings = []) {
  const sortedRecordings = [...recordings]
    .filter((recording) => hasRecordingBlob(recording))
    .sort((left, right) => Number(left.startMs || 0) - Number(right.startMs || 0));

  const batches = [];
  let currentBatch = [];
  let currentDurationMs = 0;

  const flushBatch = () => {
    if (!currentBatch.length) return;
    batches.push({
      recordings: currentBatch,
      startMs: Number(currentBatch[0].startMs || 0),
      endMs: Number(currentBatch[currentBatch.length - 1].endMs || currentBatch[currentBatch.length - 1].startMs || 0),
    });
    currentBatch = [];
    currentDurationMs = 0;
  };

  sortedRecordings.forEach((recording) => {
    const clipDurationMs = Math.max(1000, Number(recording.endMs || recording.startMs || 0) - Number(recording.startMs || 0));
    if (currentBatch.length && currentDurationMs + clipDurationMs > SPEAKER_FINALIZE_BATCH_TARGET_MS) {
      flushBatch();
    }
    currentBatch.push(recording);
    currentDurationMs += clipDurationMs;
  });
  flushBatch();

  return batches.map((batch, index) => ({
    ...batch,
    index,
    durationMs: Math.max(0, Number(batch.endMs || 0) - Number(batch.startMs || 0)),
  }));
}

async function diarizeRecordingBatch(batch, session = state.currentSession) {
  if (!batch?.recordings?.length || !session) return 0;
  if (batch.recordings.length === 1) {
    return diarizeRecordingClip(batch.recordings[0], session);
  }
  const mergedAudio = await mergeRecordingBatchToWav(batch.recordings);
  const diarized = await runDiarizeAudioChunk({
    apiKey: state.settings.apiKey,
    audioBlob: mergedAudio,
    filename: `session-final-speaker-batch-${batch.index + 1}.wav`,
    language: session.sourceLanguage,
  });
  const canonicalSegments = buildCanonicalFinalDiarizedSegments({
    diarizedSegments: diarized.segments.map((segment) => ({
      ...segment,
      startMs: Number(batch.startMs || 0) + Math.round(Number(segment.start || 0) * 1000),
      endMs: Number(batch.startMs || 0) + Math.round(Number(segment.end || 0) * 1000),
    })),
    session,
    batchIndex: Number(batch.index || 0),
  });

  return applyDiarizedRecordingPass(
    {
      audioBlob: mergedAudio,
      filename: `session-final-speaker-batch-${batch.index + 1}.wav`,
      chunkStartMs: Number(batch.startMs || 0),
      chunkEndMs: Number(batch.endMs || batch.startMs || 0),
      diarizedSegments: canonicalSegments.map((segment) => ({
        ...segment,
        start: Math.max(0, (Number(segment.startMs || 0) - Number(batch.startMs || 0)) / 1000),
        end: Math.max(0, (Number(segment.endMs || 0) - Number(batch.startMs || 0)) / 1000),
      })),
      recordings: batch.recordings,
      force: true,
    },
    session
  );
}

async function diarizeRecordingClipWithRetry(recording, session = state.currentSession, { maxAttempts = SPEAKER_FINALIZE_MAX_ATTEMPTS, onRetry } = {}) {
  let lastError = null;
  const attempts = Math.max(1, Number(maxAttempts || 1));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const applied = await diarizeRecordingClip(recording, session);
      return {
        ok: true,
        applied,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      onRetry?.(error, attempt + 1, attempts);
      await wait(SPEAKER_FINALIZE_RETRY_DELAY_MS);
    }
  }

  return {
    ok: false,
    applied: 0,
    attempts,
    error: lastError,
  };
}

async function diarizeRecordingBatchIndividually(
  batch,
  session = state.currentSession,
  { maxAttempts = SPEAKER_FINALIZE_MAX_ATTEMPTS, onRetry, onRecordingProgress } = {}
) {
  if (!batch?.recordings?.length || !session) {
    return {
      ok: true,
      applied: 0,
      attempts: 0,
      mode: 'fallback-individual',
      completedRecordings: 0,
      failedRecordings: 0,
      partial: false,
      lastError: null,
    };
  }

  let applied = 0;
  let completedRecordings = 0;
  let failedRecordings = 0;
  let lastError = null;

  for (const [index, recording] of batch.recordings.entries()) {
    onRecordingProgress?.({
      index,
      total: batch.recordings.length,
      recording,
      completedRecordings,
      failedRecordings,
    });

    const result = await diarizeRecordingClipWithRetry(recording, session, {
      maxAttempts,
      onRetry: (error, nextAttempt, totalAttempts) => {
        lastError = error;
        onRetry?.(error, nextAttempt, totalAttempts, recording, index, batch.recordings.length);
      },
    });

    if (result.ok) {
      applied += Number(result.applied || 0);
      completedRecordings += 1;
    } else {
      failedRecordings += 1;
      lastError = result.error || lastError;
    }
  }

  return {
    ok: failedRecordings === 0,
    applied,
    attempts: Math.max(1, Number(maxAttempts || 1)),
    error: lastError,
    mode: 'fallback-individual',
    completedRecordings,
    failedRecordings,
    partial: completedRecordings > 0 && failedRecordings > 0,
  };
}

async function diarizeRecordingBatchWithRetry(batch, session = state.currentSession, { maxAttempts = SPEAKER_FINALIZE_MAX_ATTEMPTS, onRetry } = {}) {
  if (batch?.recordings?.length === 1) {
    const result = await diarizeRecordingClipWithRetry(batch.recordings[0], session, { maxAttempts, onRetry });
    return {
      ...result,
      mode: 'single',
      completedRecordings: result.ok ? 1 : 0,
      failedRecordings: result.ok ? 0 : 1,
      partial: false,
    };
  }

  let lastError = null;
  const attempts = Math.max(1, Number(maxAttempts || 1));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const applied = await diarizeRecordingBatch(batch, session);
      return {
        ok: true,
        applied,
        attempts: attempt,
        mode: 'batch',
        completedRecordings: batch?.recordings?.length || 0,
        failedRecordings: 0,
        partial: false,
      };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      onRetry?.(error, attempt + 1, attempts);
      await wait(SPEAKER_FINALIZE_RETRY_DELAY_MS);
    }
  }

  return diarizeRecordingBatchIndividually(batch, session, {
    maxAttempts,
    onRetry: (error, nextAttempt, totalAttempts, recording, index, totalRecordings) => {
      onRetry?.(error, nextAttempt, totalAttempts, recording, index, totalRecordings, true);
    },
  });
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

function clearSpeakerChunkStopTimer() {
  window.clearTimeout(state.speakerChunkStopTimer);
  state.speakerChunkStopTimer = null;
}

async function stopSpeakerTracking({ statusMessage } = {}) {
  state.speakerTrackingStopRequested = true;
  clearSpeakerChunkStopTimer();
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
  state.speakerNextChunkDurationMs = SPEAKER_INITIAL_CHUNK_MS;
  state.speakerTrackingSessionId = null;

  if (statusMessage) {
    state.speakerTrackingStatus = statusMessage;
    renderSpeakerInsights();
  }
}

async function stopSessionRecording() {
  const recorder = state.sessionRecorder;
  if (recorder && recorder.state !== 'inactive') {
    await new Promise((resolve) => {
      recorder.addEventListener('stop', resolve, { once: true });
      try {
        recorder.stop();
      } catch {
        resolve();
      }
    }).catch(() => {});
  }

  await waitForPendingSessionRecordingWrites();

  stopSpeakerTracks(state.sessionRecordingStream);
  state.sessionRecorder = null;
  state.sessionRecordingStream = null;
  state.sessionRecordingMimeType = '';
  state.sessionRecordingChunkStartMs = 0;
  state.sessionRecordingSessionId = null;
}

async function startSessionRecording(stream) {
  if (!stream || !state.currentSession || typeof MediaRecorder === 'undefined') {
    stopSpeakerTracks(stream);
    return;
  }

  await stopSessionRecording();

  try {
    const mimeType = pickSpeakerCaptureMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const sessionId = state.currentSession.id;
    const effectiveMimeType = recorder.mimeType || mimeType || 'audio/webm';
    let chunkStartMs = getEffectiveActiveDuration();

    state.sessionRecorder = recorder;
    state.sessionRecordingStream = stream;
    state.sessionRecordingMimeType = effectiveMimeType;
    state.sessionRecordingChunkStartMs = chunkStartMs;
    state.sessionRecordingSessionId = sessionId;
    state.sessionRecordingSupported = true;

    recorder.addEventListener('dataavailable', (event) => {
      if (!event.data?.size) return;
      const chunkEndMs = getEffectiveActiveDuration();
      const blob = event.data;
      const startMs = chunkStartMs;
      chunkStartMs = chunkEndMs;
      state.sessionRecordingChunkStartMs = chunkEndMs;
      if (chunkEndMs <= startMs) return;
      const persistTask = persistRecordingClip({
        sessionId,
        blob,
        startMs,
        endMs: chunkEndMs,
        mimeType: effectiveMimeType,
      }).catch((error) => {
        console.warn('Unable to persist session recording clip', error);
      });
      trackPendingSessionRecordingWrite(persistTask);
    });

    recorder.addEventListener(
      'stop',
      () => {
        state.sessionRecorder = null;
      },
      { once: true }
    );

    recorder.start(SESSION_RECORDING_CHUNK_MS);
  } catch (error) {
    console.warn('Unable to start local session recording', error);
    state.sessionRecordingSupported = false;
    stopSpeakerTracks(stream);
  }
}

async function flushSpeakerRecorderChunk({ continueTracking = true } = {}) {
  const recorder = state.speakerRecorder;
  if (!recorder || recorder.state === 'inactive') return false;

  state.speakerTrackingStopRequested = !continueTracking;
  clearSpeakerChunkStopTimer();

  await new Promise((resolve) => {
    recorder.addEventListener('stop', resolve, { once: true });
    try {
      recorder.stop();
    } catch {
      resolve();
    }
  }).catch(() => {});

  return true;
}

function isSpeakerAttributionIdle(sessionId = state.currentSession?.id) {
  const pendingSegments = getPendingSpeakerSegmentCount(sessionId);
  return pendingSegments === 0 && state.speakerTrackingPendingChunks === 0 && !state.speakerTrackingInFlight;
}

async function waitForSpeakerAttributionIdle({ sessionId = state.currentSession?.id, timeoutMs = 120000, pollMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (isSpeakerAttributionIdle(sessionId)) return true;
    await new Promise((resolve) => window.setTimeout(resolve, pollMs));
  }

  return isSpeakerAttributionIdle(sessionId);
}

async function startSpeakerTimingFromCurrentSession() {
  if (!state.currentSession) {
    showToast('Create or open a session first.');
    return false;
  }

  if (!state.speakerTrackingSupported) {
    showToast('Speaker timing is not supported in this browser.');
    return false;
  }

  const sourceStream = state.client?.mediaStream;
  if (!sourceStream?.clone) {
    showToast('Speaker timing cannot start from the current live session right now.', 4500);
    return false;
  }

  const liveTracks = sourceStream.getAudioTracks?.() || [];
  if (!liveTracks.some((track) => track.readyState !== 'ended')) {
    showToast('Speaker timing needs an active microphone stream.', 4500);
    return false;
  }

  state.speakerTrackingStatus = 'Starting speaker timing from the current live microphone...';
  state.speakerNextChunkDurationMs = SPEAKER_INITIAL_CHUNK_MS;
  renderSpeakerInsights();

  try {
    await startSpeakerTracking(sourceStream.clone());
    const started = Boolean(state.speakerRecorder && state.speakerRecorder.state !== 'inactive');
    if (started) {
      showToast('Speaker timing started. First results should arrive sooner now.');
      return true;
    }
  } catch (error) {
    console.warn('Unable to start speaker timing from the live session', error);
  }

  showToast('Speaker timing could not start right now.', 4500);
  return false;
}

async function finalizeSpeakerTiming() {
  if (!state.currentSession) {
    showToast('Create or open a session first.');
    return;
  }

  if (!state.speakerTrackingSupported) {
    showToast('Speaker timing is not supported in this browser.');
    return;
  }

  if (state.speakerFinalizeInProgress) return;

  const sessionId = state.currentSession.id;
  const continueTracking = Boolean(state.client && state.currentSession.status === 'active');
  const hasRecorder = Boolean(
    state.speakerTrackingSessionId === sessionId && state.speakerRecorder && state.speakerRecorder.state !== 'inactive'
  );
  const hadQueuedWork = !isSpeakerAttributionIdle(sessionId);
  await waitForPendingSessionRecordingWrites();
  const recordings = state.sessionRecordings.length ? state.sessionRecordings : await refreshSessionRecordings(sessionId);
  const pendingRecordingPasses = recordings.filter((recording) => !recording.diarizedAt && hasRecordingBlob(recording));

  if (!hasRecorder && !hadQueuedWork && !pendingRecordingPasses.length) {
    if (canStartSpeakerTrackingManually(state.currentSession)) {
      state.speakerFinalizeInProgress = true;
      renderSpeakerFinalizeButton();
      try {
        await startSpeakerTimingFromCurrentSession();
      } finally {
        state.speakerFinalizeInProgress = false;
        renderSpeakerInsights();
      }
      return;
    }

    showToast('There is no queued speaker timing to finalize right now.');
    renderSpeakerFinalizeButton();
    return;
  }

  state.speakerFinalizeInProgress = true;
  setSpeakerFinalizeProgress({
    total: pendingRecordingPasses.length,
    completed: 0,
    failed: 0,
    currentIndex: pendingRecordingPasses.length ? 1 : 0,
    statusLine: pendingRecordingPasses.length
      ? 'Running the final speaker pass across the saved session audio...'
      : hasRecorder
        ? continueTracking
          ? 'Capturing the current speaker chunk for the final speaker pass...'
          : 'Capturing the last speaker chunk...'
        : 'Finishing queued speaker timing...',
    note: pendingRecordingPasses.length
      ? 'Preparing the saved clips for the final speaker pass now.'
      : 'Working through the queued speaker timing now.',
  });
  state.speakerTrackingStatus = pendingRecordingPasses.length
    ? 'Running the final speaker pass across the saved session audio...'
    : hasRecorder
      ? continueTracking
        ? 'Capturing the current speaker chunk for the final speaker pass...'
        : 'Capturing the last speaker chunk...'
      : 'Finishing queued speaker timing...';
  renderSpeakerInsights();
  renderRecordingReview();

  try {
    if (hasRecorder) {
      await flushSpeakerRecorderChunk({ continueTracking });
    }

    await waitForPendingSessionRecordingWrites();
    const refreshedRecordings = await refreshSessionRecordings(sessionId);
    const storedPasses = refreshedRecordings.filter((recording) => !recording.diarizedAt && recording.blob?.size);
    const finalBatches = buildSpeakerFinalizeBatches(storedPasses);
    let completedPasses = 0;
    let failedPasses = 0;

    if (storedPasses.length) {
      state.currentSession.speakerFinalizedAt = '';
      state.speakerSpansBySession.set(sessionId, []);
      await persistCurrentSessionNow();
    }

    for (const [index, batch] of finalBatches.entries()) {
      const totalPasses = finalBatches.length;
      const clipRange = `${formatDurationShort(batch.startMs || 0)} to ${formatDurationShort(batch.endMs || batch.startMs || 0)}`;
      const clipCount = batch.recordings.length;
      setSpeakerFinalizeProgress({
        total: totalPasses,
        completed: completedPasses,
        failed: failedPasses,
        currentIndex: index + 1,
        statusLine: `Analyzing final speaker batch ${index + 1} of ${totalPasses}...`,
        note: `Batch ${index + 1} of ${totalPasses}, ${clipCount} clip${clipCount === 1 ? '' : 's'} (${clipRange}).`,
      });
      state.speakerTrackingStatus = `Analyzing final speaker batch ${index + 1} of ${totalPasses}...`;
      renderSpeakerInsights();

      const result = await diarizeRecordingBatchWithRetry(batch, state.currentSession, {
        onRetry: (error, nextAttempt, maxAttempts, recording, recordingIndex, totalRecordings, usingClipFallback = false) => {
          setSpeakerFinalizeProgress({
            total: totalPasses,
            completed: completedPasses,
            failed: failedPasses,
            currentIndex: index + 1,
            statusLine: usingClipFallback
              ? `Retrying clip ${Number(recordingIndex || 0) + 1} of ${Number(totalRecordings || clipCount)} inside final batch ${index + 1}...`
              : `Retrying final speaker batch ${index + 1} of ${totalPasses}...`,
            note: usingClipFallback
              ? `The merged final pass fell back to individual clips. Retrying clip ${Number(recordingIndex || 0) + 1}/${Number(
                  totalRecordings || clipCount
                )}, attempt ${nextAttempt}/${maxAttempts}${recording?.startMs !== undefined ? ` (${formatDurationShort(recording.startMs || 0)})` : ''}.`
              : `Batch ${index + 1} of ${totalPasses} hit a temporary issue. Retrying ${nextAttempt}/${maxAttempts}...`,
          });
          state.speakerTrackingStatus = usingClipFallback
            ? `Retrying saved clip ${Number(recordingIndex || 0) + 1} of ${Number(totalRecordings || clipCount)}...`
            : `Retrying final speaker batch ${index + 1} of ${totalPasses}...`;
          if (error?.message) {
            console.warn('Retrying final speaker batch after diarization error', error);
          }
          renderSpeakerInsights();
        },
      });

      if (result.ok) {
        completedPasses += 1;
        setSpeakerFinalizeProgress({
          total: totalPasses,
          completed: completedPasses,
          failed: failedPasses,
          currentIndex: Math.min(totalPasses, index + 1),
          statusLine: `Analyzing final speaker batch ${index + 1} of ${totalPasses}...`,
          note:
            result.mode === 'fallback-individual'
              ? `Finished batch ${index + 1} of ${totalPasses} with clip-by-clip recovery.`
              : `Finished batch ${index + 1} of ${totalPasses}.`,
        });
      } else {
        failedPasses += 1;
        console.warn('Final speaker batch diarization failed', result.error);
        setSpeakerFinalizeProgress({
          total: totalPasses,
          completed: completedPasses,
          failed: failedPasses,
          currentIndex: Math.min(totalPasses, index + 1),
          statusLine:
            result.partial || result.mode === 'fallback-individual'
              ? `Final batch ${index + 1} of ${totalPasses} only finished partly. The remaining clips stay queued.`
              : `Final speaker batch ${index + 1} of ${totalPasses} will stay queued for another try.`,
          note:
            result.partial || result.mode === 'fallback-individual'
              ? `Batch ${index + 1} of ${totalPasses} recovered ${Number(result.completedRecordings || 0)} clip${
                  Number(result.completedRecordings || 0) === 1 ? '' : 's'
                }, while ${Number(result.failedRecordings || clipCount)} clip${Number(result.failedRecordings || clipCount) === 1 ? '' : 's'} still need another try.`
              : `Batch ${index + 1} of ${totalPasses} could not be processed yet. It will stay queued for another try.`,
        });
      }

      renderSpeakerInsights();
    }

    if (storedPasses.length) {
      await applyManualSpeakerEventsToCurrentSession();
    }

    const finalized = await waitForSpeakerAttributionIdle({
      sessionId,
      timeoutMs: continueTracking ? 30000 : 120000,
    });

    const latestRecordings = await refreshSessionRecordings(sessionId);
    const remainingRecordingPasses = latestRecordings.filter((recording) => !recording.diarizedAt && hasRecordingBlob(recording)).length;

    if (remainingRecordingPasses > 0) {
      const processedPasses = Math.max(0, storedPasses.length - remainingRecordingPasses);
      state.currentSession.speakerFinalizedAt = '';
      await persistCurrentSessionNow();
      state.speakerTrackingStatus = processedPasses
        ? `Final speaker timing updated for ${processedPasses} clip${processedPasses === 1 ? '' : 's'}. ${remainingRecordingPasses} clip${remainingRecordingPasses === 1 ? '' : 's'} still need another try.`
        : `Final speaker timing hit a temporary issue. ${remainingRecordingPasses} clip${remainingRecordingPasses === 1 ? '' : 's'} still need another try.`;
      showToast(
        processedPasses
          ? `Final speaker timing updated for ${processedPasses}/${storedPasses.length || remainingRecordingPasses} clips. ${remainingRecordingPasses} still queued.`
          : 'Final speaker timing hit a temporary issue. The remaining clips stay queued for retry.',
        5000
      );
    } else if (finalized) {
      state.currentSession.speakerFinalizedAt = nowIso();
      await persistCurrentSessionNow();
      state.speakerTrackingStatus = 'Final speaker timing updated.';
      showToast('Final speaker timing is ready.');
    } else {
      state.speakerTrackingStatus = 'Speaker timing is still catching up.';
      showToast('Speaker timing is still catching up in the background.', 4500);
    }
  } catch (error) {
    console.warn('Unable to finalize speaker timing', error);
    state.currentSession.speakerFinalizedAt = '';
    await persistCurrentSessionNow();
    state.speakerTrackingStatus = 'Speaker timing hit a temporary issue. The remaining clips stay queued for retry.';
    showToast('Speaker timing hit a temporary issue. Try the remaining clips again in a moment.', 5000);
  } finally {
    state.speakerFinalizeInProgress = false;
    setSpeakerFinalizeProgress(null);
    renderSpeakerInsights();
    renderRecordingReview();
  }
}

function shouldContinueSpeakerTracking(sessionId, stream) {
  return Boolean(
    !state.speakerTrackingStopRequested &&
      state.speakerTrackingSessionId === sessionId &&
      state.speakerStream === stream &&
      state.currentSession?.id === sessionId &&
      state.currentSession.status === 'active'
  );
}

function startSpeakerChunkRecorder({ sessionId, sourceLanguage }) {
  const stream = state.speakerStream;
  if (!stream || state.speakerTrackingStopRequested) return;

  try {
    const preferredMimeType = state.speakerMimeType || pickSpeakerCaptureMimeType();
    const recorder = preferredMimeType ? new MediaRecorder(stream, { mimeType: preferredMimeType }) : new MediaRecorder(stream);
    const chunkParts = [];
    const chunkStartMs = state.speakerChunkStartMs;
    const effectiveMimeType =
      recorder.mimeType || preferredMimeType || stream.getAudioTracks?.()[0]?.getSettings?.().mimeType || 'audio/webm';

    state.speakerRecorder = recorder;
    state.speakerMimeType = effectiveMimeType;

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data?.size) {
        chunkParts.push(event.data);
      }
    });

    recorder.addEventListener(
      'stop',
      () => {
        clearSpeakerChunkStopTimer();
        if (state.speakerRecorder === recorder) {
          state.speakerRecorder = null;
        }

        const chunkEndMs = getEffectiveActiveDuration();
        state.speakerChunkStartMs = chunkEndMs;

        const chunkBlob = chunkParts.length ? new Blob(chunkParts, { type: effectiveMimeType }) : null;
        if (chunkBlob && chunkBlob.size >= SPEAKER_MIN_CHUNK_BYTES && chunkEndMs > chunkStartMs) {
          state.speakerChunkIndex += 1;
          queueSpeakerAttribution({
            index: state.speakerChunkIndex,
            blob: chunkBlob,
            startMs: chunkStartMs,
            endMs: chunkEndMs,
            mimeType: effectiveMimeType,
            sessionId,
            sourceLanguage,
          });
        }

        if (shouldContinueSpeakerTracking(sessionId, stream)) {
          startSpeakerChunkRecorder({ sessionId, sourceLanguage });
        }
      },
      { once: true }
    );

    recorder.addEventListener(
      'error',
      () => {
        clearSpeakerChunkStopTimer();
        state.speakerRecorder = null;
        state.speakerTrackingSessionId = null;
        stopSpeakerTracks(stream);
        state.speakerStream = null;
        state.speakerTrackingStatus = 'Speaker timing stopped. Tap the button to retry.';
        renderSpeakerInsights();
      },
      { once: true }
    );

    recorder.start();
    const chunkDurationMs = Math.max(3000, Number(state.speakerNextChunkDurationMs || SPEAKER_CHUNK_MS));
    state.speakerNextChunkDurationMs = SPEAKER_CHUNK_MS;
    state.speakerChunkStopTimer = window.setTimeout(() => {
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      } catch {
        // ignore
      }
    }, chunkDurationMs);
  } catch (error) {
    console.warn('Unable to rotate background speaker recorder', error);
    stopSpeakerTracks(stream);
    state.speakerRecorder = null;
    state.speakerStream = null;
    state.speakerTrackingSessionId = null;
    state.speakerTrackingStatus = 'Speaker timing stopped. Tap the button to retry.';
    renderSpeakerInsights();
  }
}

function rememberSpeakerSpans(sessionId, speakerSpans) {
  if (!sessionId || !speakerSpans?.length) return;
  const existing = state.speakerSpansBySession.get(sessionId) || [];
  const merged = [...existing, ...speakerSpans]
    .sort((a, b) => (a.startMs || 0) - (b.startMs || 0))
    .slice(-400);
  state.speakerSpansBySession.set(sessionId, merged);
}

function getBestSpeakerMatchForSegment(segment, speakerSpans) {
  if (!segment || !speakerSpans?.length) return null;

  const segmentStartMs = Number(segment.startMs || 0);
  const segmentEndMs = Number(segment.endMs || segmentStartMs);
  const segmentDurationMs = Math.max(600, segmentEndMs - segmentStartMs);
  let bestMatch = null;

  for (const speakerSpan of speakerSpans) {
    const sharedMs = overlapMs(segmentStartMs, segmentEndMs, speakerSpan.startMs, speakerSpan.endMs);
    const timeScore = sharedMs / segmentDurationMs;
    const textScore = computeWordOverlapScore(segment.sourceText, speakerSpan.text);
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

  if (!bestMatch) return null;
  if (bestMatch.score < 0.22 && bestMatch.textScore < 0.5) return null;
  return bestMatch;
}

function buildSpeakerLabeledSegment(transcriptSegment, session, bestMatch) {
  if (!transcriptSegment || !bestMatch) return transcriptSegment;

  return {
    ...transcriptSegment,
    speakerRawLabel: bestMatch.rawSpeaker,
    speakerLabel: resolveSpeakerLabel(bestMatch.rawSpeaker, session, bestMatch.label),
    speakerScore: Number(bestMatch.score.toFixed(3)),
    speakerConfidence: Math.min(1, Number((bestMatch.timeScore + bestMatch.textScore * 0.25).toFixed(3))),
    speakerDurationMs: Math.max(transcriptSegment.speakerDurationMs || 0, Math.round(bestMatch.sharedMs || 0)),
    speakerStatus: 'done',
    speakerUpdatedAt: nowIso(),
  };
}

async function applyStoredSpeakerSpansToSegment(segment, session = state.currentSession) {
  const sessionId = segment?.sessionId;
  if (!sessionId) return segment;
  const speakerSpans = state.speakerSpansBySession.get(sessionId) || [];
  if (!speakerSpans.length) return segment;

  const bestMatch = getBestSpeakerMatchForSegment(segment, speakerSpans);
  if (!bestMatch) return segment;

  const existingScore = Number(segment.speakerScore || 0);
  if (segment.speakerLabel && existingScore >= bestMatch.score + 0.05) {
    return segment;
  }

  const labeledSegment = buildSpeakerLabeledSegment(segment, session, bestMatch);
  await upsertSegment(labeledSegment);
  if (state.currentSession?.id === sessionId) {
    upsertCurrentSegmentInState(labeledSegment);
  }
  return labeledSegment;
}

function syncManualSpeakerStateToSession(session = state.currentSession) {
  if (!session) return;
  session.manualSpeakerEvents = normalizeManualSpeakerSegments(state.manualSpeakerEvents, session).map((event, index) => ({
    ...event,
    id: getManualSpeakerEntryId(event, index),
  }));
  session.manualSpeakerOpenStartMs = state.manualSpeakerOpenStartMs === null ? null : Math.max(0, Number(state.manualSpeakerOpenStartMs || 0));
  session.manualSpeakerActiveLabel = String(state.manualSpeakerActiveLabel || '').trim();
  session.manualSpeakerCurrentLabel = String(state.manualSpeakerCurrentLabel || '').trim();
  session.manualSpeakerBaseOffsetMs = Math.max(0, Number(state.manualSpeakerBaseOffsetMs || 0));
  session.manualSpeakerElapsedMs = Math.max(0, Number(state.manualSpeakerElapsedMs || 0));
  session.manualSpeakerPaused = Boolean(state.manualSpeakerPaused);
  session.manualSpeakerPendingChangeAtMs = state.manualSpeakerPendingChangeAtMs === null ? null : Math.max(0, Number(state.manualSpeakerPendingChangeAtMs || 0));
}

async function persistManualSpeakerStateNow() {
  if (!state.currentSession) return;
  syncManualSpeakerStateToSession();
  await persistCurrentSessionNow();
}

async function applyManualSpeakerEventsToCurrentSession() {
  if (!state.currentSession) return;
  const session = state.currentSession;
  syncManualSpeakerStateToSession(session);
  const updatedSegments = [];

  for (const segment of state.currentSegments) {
    const manualLabel = getManualSpeakerLabelForSegment(segment, session);
    const automaticLabel = getAutomaticSpeakerLabelForSegment(segment, session);
    const nextLabel = String(manualLabel || automaticLabel || '').trim();
    const nextConfidence = manualLabel
      ? 1
      : automaticLabel
        ? Math.max(Number(segment.speakerConfidence || 0), 0.55)
        : 0;

    if (
      String(segment.speakerLabel || '').trim() === nextLabel &&
      (!manualLabel || Number(segment.speakerConfidence || 0) === nextConfidence)
    ) {
      continue;
    }

    const updatedSegment = {
      ...segment,
      speakerLabel: nextLabel,
      speakerRawLabel: segment.speakerRawLabel || '',
      speakerStatus: nextLabel ? 'done' : segment.speakerStatus,
      speakerUpdatedAt: nowIso(),
      speakerScore: manualLabel ? Math.max(Number(segment.speakerScore || 0), 1) : Number(segment.speakerScore || 0),
      speakerConfidence: nextConfidence,
    };
    await upsertSegment(updatedSegment);
    updatedSegments.push(updatedSegment);
  }

  updatedSegments.forEach((segment) => upsertCurrentSegmentInState(segment));
  await persistCurrentSessionNow();
  renderTranscript();
  renderSpeakerInsights();
}

async function applySpeakerLabelsFromDiarizedChunk({ sessionId, chunkStartMs, chunkEndMs, diarizedSegments, force = false }) {
  const session = state.currentSession?.id === sessionId ? state.currentSession : await getSession(sessionId);
  const speakerSpans = diarizedSegments
    .map((segment) => ({
      label: String(segment.label || formatSpeakerLabel(segment.speaker)).trim(),
      rawSpeaker: String(segment.rawSpeaker || segment.speaker || '').trim(),
      text: segment.text || '',
      startMs: chunkStartMs + Math.round(Number(segment.start || 0) * 1000),
      endMs: chunkStartMs + Math.round(Number(segment.end || 0) * 1000),
    }))
    .filter((segment) => segment.label && segment.endMs > segment.startMs);

  if (!speakerSpans.length) return 0;

  rememberSpeakerSpans(sessionId, speakerSpans);

  const sessionSegments = state.currentSession?.id === sessionId ? [...state.currentSegments] : await listSegmentsBySession(sessionId);
  const relevantSegments = sessionSegments.filter(
    (segment) => (segment.endMs || 0) >= chunkStartMs - SPEAKER_MATCH_MARGIN_MS && (segment.startMs || 0) <= chunkEndMs + SPEAKER_MATCH_MARGIN_MS
  );

  if (!relevantSegments.length) return 0;

  let applied = 0;

  for (const transcriptSegment of relevantSegments) {
    const bestMatch = getBestSpeakerMatchForSegment(transcriptSegment, speakerSpans);
    if (!bestMatch) continue;

    const existingScore = Number(transcriptSegment.speakerScore || 0);
    if (!force && transcriptSegment.speakerLabel && existingScore >= bestMatch.score + 0.05) continue;

    const updatedSegment = buildSpeakerLabeledSegment(transcriptSegment, session, bestMatch);

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
    state.speakerTrackingStatus = 'Updating speaker timing...';
    renderSpeakerInsights();
  }

  state.speakerAttributionQueue = state.speakerAttributionQueue
    .then(async () => {
      state.speakerTrackingInFlight = true;
      const filenameExtension = chunk.mimeType.includes('mp4') ? 'm4a' : chunk.mimeType.includes('ogg') ? 'ogg' : 'webm';
      const diarized = await runDiarizeAudioChunk({
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
        state.speakerTrackingStatus = 'Speaker timing updated.';
      }
    })
    .catch((error) => {
      console.warn('Speaker diarization failed', error);
      if (state.currentSession?.id === chunk.sessionId) {
        state.speakerTrackingStatus = 'Speaker timing is catching up.';
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
    state.speakerTrackingStatus = 'Speaker timing is not supported in this browser.';
    stopSpeakerTracks(stream);
    renderSpeakerInsights();
    return;
  }

  const mimeType = pickSpeakerCaptureMimeType();

  try {
    const sessionId = state.currentSession.id;
    const sourceLanguage = state.currentSession.sourceLanguage;

    state.speakerTrackingSupported = true;
    state.speakerTrackingStopRequested = false;
    state.speakerStream = stream;
    state.speakerMimeType = mimeType || stream.getAudioTracks?.()[0]?.getSettings?.().mimeType || 'audio/webm';
    state.speakerChunkStartMs = getEffectiveActiveDuration();
    state.speakerNextChunkDurationMs = Math.max(3000, Number(state.speakerNextChunkDurationMs || SPEAKER_INITIAL_CHUNK_MS));
    state.speakerTrackingSessionId = sessionId;
    state.speakerTrackingStatus = 'Buffering speaker timing in parallel. First results usually arrive after about 8 seconds.';
    renderSpeakerInsights();
    startSpeakerChunkRecorder({ sessionId, sourceLanguage });
  } catch (error) {
    console.warn('Unable to start background speaker tracking', error);
    state.speakerTrackingSupported = true;
    state.speakerTrackingSessionId = null;
    state.speakerStream = null;
    state.speakerRecorder = null;
    state.speakerTrackingStatus = 'Speaker timing could not start. Tap the button to retry.';
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
  state.sessionRecordings = [];
  resetSessionPlaybackState();
  state.manualSpeakerEvents = [];
  state.manualSpeakerOpenStartMs = null;
  state.manualSpeakerActiveLabel = '';
  state.manualSpeakerBaseOffsetMs = 0;
  state.manualSpeakerElapsedMs = 0;
  state.manualSpeakerPaused = true;
  state.manualSpeakerPendingChangeAtMs = null;
  state.speakerFinalizeProgress = null;
  state.manualSpeakerCurrentLabel = getSpeakerOptionsForManualControls(session)[0] || 'Speaker A';
  state.manualSpeakerCustomNameDraft = '';
  state.manualSpeakerEditingEventId = '';
  state.transcriptPinnedToBottom = true;
  clearLiveDraftCarry();
  state.currentSession.status = 'active';
  state.currentSession.runtimeStatus = 'connecting';
  state.currentSession.updatedAt = nowIso();
  await resumeManualSpeakerTimer({ persist: false });
  await persistCurrentSessionNow();
  await syncLastActiveSession();
  await refreshSessions();
  renderCurrentView();
  setRoute('live');
  await startListening();
}

function buildRealtimeClientOptions() {
  return {
    apiKey: state.settings.apiKey,
    sourceLanguage: state.currentSession.sourceLanguage,
    sourceLanguageName: getLanguageName(state.currentSession.sourceLanguage),
    targetLanguageName: getLanguageName(state.currentSession.targetLanguage),
    glossary: buildSessionGlossary(state.currentSession),
    transcriptionModel: normalizeRealtimeTranscriptionModel(state.settings.realtimeTranscriptionModel),
    microphoneDeviceId: state.settings.microphoneDeviceId,
    echoCancellation: normalizeAudioProcessingEnabled(state.settings.echoCancellation),
    noiseSuppression: normalizeAudioProcessingEnabled(state.settings.noiseSuppression),
    autoGainControl: normalizeAudioProcessingEnabled(state.settings.autoGainControl),
    onEvent: handleRealtimeEvent,
    onStreamAvailable: (stream) => {
      startSessionRecording(stream.clone()).catch((error) => {
        console.warn('Local session recording failed to start', error);
      });
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
      await pauseManualSpeakerTimer({ persist: false });
      await stopSpeakerTracking({ statusMessage: 'Speaker timing paused.' });
      await stopSessionRecording();
      await ensureScreenWakeLock(false);
      flushListeningClock();
      flushSpeechClock();
      setStatus('error', message);
      if (state.currentSession) {
        state.currentSession.status = 'paused';
        state.currentSession.runtimeStatus = 'error';
      }
      await persistCurrentSessionNow();
      showToast(message, 5000);
    },
  };
}

function getRealtimeClientPreview() {
  if (!state.currentSession) return null;
  const options = buildRealtimeClientOptions();
  return {
    sourceLanguage: options.sourceLanguage,
    sourceLanguageName: options.sourceLanguageName,
    targetLanguageName: options.targetLanguageName,
    transcriptionModel: options.transcriptionModel,
    microphoneDeviceId: options.microphoneDeviceId,
    echoCancellation: options.echoCancellation,
    noiseSuppression: options.noiseSuppression,
    autoGainControl: options.autoGainControl,
    sessionConfigPreview: buildRealtimeTranscriptionSessionPreview({
      transcriptionModel: options.transcriptionModel,
      sourceLanguage: options.sourceLanguage,
      sourceLanguageName: options.sourceLanguageName,
      targetLanguageName: options.targetLanguageName,
      glossary: state.currentSession?.glossary || state.settings.glossary || '',
      conservative: false,
    }),
    conservativeSessionConfigPreview: buildRealtimeTranscriptionSessionPreview({
      transcriptionModel: options.transcriptionModel,
      sourceLanguage: options.sourceLanguage,
      sourceLanguageName: options.sourceLanguageName,
      targetLanguageName: options.targetLanguageName,
      glossary: state.currentSession?.glossary || state.settings.glossary || '',
      conservative: true,
    }),
  };
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
    await stopSpeakerTracking({ statusMessage: 'Refreshing speaker timing...' });
    await stopSessionRecording();
    await state.client.disconnect({ nextStatus: 'stopped', message: 'Resetting the live connection...' });
    state.client = null;
  }

  resetLiveCommitState();
  state.speechActive = false;
  setStatus('connecting', 'Requesting microphone access and opening a live transcription connection...');
  state.currentSession.status = 'active';
  state.currentSession.runtimeStatus = 'connecting';
  state.currentSession.speakerFinalizedAt = '';
  state.currentSession.updatedAt = nowIso();
  if (state.manualSpeakerPaused) {
    await resumeManualSpeakerTimer({ persist: false });
  }
  await persistCurrentSessionNow();
  await syncLastActiveSession();
  if (state.settings.autoScroll && state.route === 'live') {
    scrollTranscriptToLive('auto');
  }

  const client = new RealtimeTranscriptionClient(buildRealtimeClientOptions());

  state.client = client;

  try {
    await client.connect();
    await ensureScreenWakeLock(true);
    refreshMicrophoneOptions({ silent: true }).catch(() => {});
    markListeningStart();
    startClockTimer();
    if (!silent) {
      showToast('Live transcription started.');
    }
  } catch (error) {
    resetLiveCommitState();
    state.speechActive = false;
    await pauseManualSpeakerTimer({ persist: false });
    await stopSpeakerTracking({ statusMessage: 'Speaker timing idle.' });
    await stopSessionRecording();
    await ensureScreenWakeLock(false);
    state.client = null;
    const message = error?.message || 'Unable to start live transcription.';
    setStatus('error', message);
    if (state.currentSession) {
      state.currentSession.status = 'paused';
      state.currentSession.runtimeStatus = 'error';
      await persistCurrentSessionNow();
    }
    showToast(message, 5000);
  }
}

async function pauseListening() {
  if (!state.currentSession) return;
  const pausedMessage = 'Paused. Microphone sending has stopped.';
  resetLiveCommitState();
  flushListeningClock();
  flushSpeechClock();
  state.speechActive = false;
  if (!state.manualSpeakerPaused) {
    await pauseManualSpeakerTimer({ persist: false });
  }
  await stopSpeakerTracking({ statusMessage: 'Paused. Speaker timing may keep catching up briefly.' });
  await stopSessionRecording();
  if (state.client) {
    await state.client.disconnect({ nextStatus: 'paused', message: pausedMessage });
  }
  await ensureScreenWakeLock(false);
  state.client = null;
  state.currentSession.status = 'paused';
  state.currentSession.runtimeStatus = 'paused';
  await applyManualSpeakerEventsToCurrentSession();
  await persistCurrentSessionNow();
  await syncLastActiveSession();
  setStatus('paused', pausedMessage);
  renderCurrentView();
}

async function stopListening() {
  if (!state.currentSession) return;
  const stoppedMessage = 'Stopped. Tap Resume to continue this session.';
  resetLiveCommitState();
  flushListeningClock();
  flushSpeechClock();
  state.speechActive = false;
  if (!state.manualSpeakerPaused) {
    await pauseManualSpeakerTimer({ persist: false });
  }
  await stopSpeakerTracking({ statusMessage: 'Stopped. Run the final speaker pass for the last buffered audio.' });
  await stopSessionRecording();
  if (state.client) {
    await state.client.disconnect({ nextStatus: 'stopped', message: stoppedMessage });
    await ensureScreenWakeLock(false);
    state.client = null;
  }
  await ensureScreenWakeLock(false);
  state.currentSession.status = 'paused';
  state.currentSession.runtimeStatus = 'stopped';
  await applyManualSpeakerEventsToCurrentSession();
  await persistCurrentSessionNow();
  await syncLastActiveSession();
  setStatus('stopped', stoppedMessage);
  renderCurrentView();
}

async function endCurrentSession() {
  if (!state.currentSession) return;
  const confirmed = window.confirm('End this session? The transcript stays in local history, but live capture will stop.');
  if (!confirmed) return;

  resetLiveCommitState();
  flushListeningClock();
  flushSpeechClock();
  state.speechActive = false;
  if (!state.manualSpeakerPaused) {
    await pauseManualSpeakerTimer({ persist: false });
  }
  await stopSpeakerTracking({ statusMessage: 'Ending session. Run the final speaker pass for the last buffered audio.' });
  await stopSessionRecording();
  if (state.client) {
    await state.client.disconnect({ nextStatus: 'ended', message: 'Session ended.' });
    await ensureScreenWakeLock(false);
    state.client = null;
  }
  await ensureScreenWakeLock(false);

  state.currentSession.status = 'ended';
  state.currentSession.runtimeStatus = 'ended';
  state.currentSession.endedAt = nowIso();
  state.currentSession.updatedAt = nowIso();
  state.currentSession.draftSource = '';
  state.currentSession.draftTranslation = '';
  await applyManualSpeakerEventsToCurrentSession();
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

async function pauseManualSpeakerTimer({ persist = true } = {}) {
  if (state.manualSpeakerPaused) {
    renderManualSpeakerControls();
    return;
  }

  syncManualSpeakerSelectionFromUi();
  await commitCurrentManualSpeakerSpan({ atMs: getManualSpeakerSessionPositionMs(), persist: false });
  state.manualSpeakerElapsedMs = getManualSpeakerElapsedMs();
  state.manualSpeakerPaused = true;
  syncManualSpeakerStateToSession();

  if (persist) {
    await persistManualSpeakerStateNow();
  }

  renderManualSpeakerControls();
}

async function resumeManualSpeakerTimer({ persist = true } = {}) {
  if (!state.currentSession || state.currentSession.status !== 'active') {
    renderManualSpeakerControls();
    return;
  }

  syncManualSpeakerSelectionFromUi();
  state.manualSpeakerPaused = false;
  state.manualSpeakerBaseOffsetMs = Math.max(0, getManualSpeakerSessionPositionMs() - Number(state.manualSpeakerElapsedMs || 0));
  state.manualSpeakerOpenStartMs = Math.max(0, getManualSpeakerSessionPositionMs());
  state.manualSpeakerActiveLabel = normalizeManualSpeakerName(state.manualSpeakerCurrentLabel || getResolvedManualSpeakerSelection());
  clearPendingManualSpeakerChange();
  syncManualSpeakerStateToSession();

  if (persist) {
    await persistManualSpeakerStateNow();
  }

  renderManualSpeakerControls();
}

async function markManualSpeakerChange({ atMs = getManualSpeakerSessionPositionMs(), autoStart = true } = {}) {
  if (!state.currentSession || state.currentSession.status !== 'active') return;
  if (state.manualSpeakerPaused && autoStart) {
    await resumeManualSpeakerTimer({ persist: false });
  }
  await splitManualSpeakerSpan({ atMs, persist: false });
}

async function resetManualSpeakerChanges() {
  state.manualSpeakerEvents = [];
  state.manualSpeakerOpenStartMs = null;
  state.manualSpeakerActiveLabel = '';
  state.manualSpeakerBaseOffsetMs = getManualSpeakerSessionPositionMs();
  state.manualSpeakerElapsedMs = 0;
  clearPendingManualSpeakerChange();
  state.manualSpeakerEditingEventId = '';
  await applyManualSpeakerEventsToCurrentSession();
  renderManualSpeakerControls();
  renderSpeakerInsights();
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

  const labeledSegment = await applyStoredSpeakerSpansToSegment(segment, state.currentSession);

  upsertCurrentSegmentInState(labeledSegment);
  await upsertSegment(labeledSegment);
  clearDraftState(itemId, { preserveVisibleDraft: true });
  await persistCurrentSessionNow();
  renderCurrentView();
  queueFinalSegmentTranslation(labeledSegment);
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

  if (event.type === 'transcripto.realtime_model_fallback') {
    showToast('gpt-realtime-whisper timed out at OpenAI, so this session switched back to the balanced default model.', 5200);
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
  const previousSettings = { ...state.settings };
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

  const captureRestartRequired =
    previousSettings.realtimeTranscriptionModel !== values.realtimeTranscriptionModel ||
    previousSettings.microphoneDeviceId !== values.microphoneDeviceId ||
    normalizeAudioProcessingEnabled(previousSettings.echoCancellation) !== values.echoCancellation ||
    normalizeAudioProcessingEnabled(previousSettings.noiseSuppression) !== values.noiseSuppression ||
    normalizeAudioProcessingEnabled(previousSettings.autoGainControl) !== values.autoGainControl;

  if (captureRestartRequired && state.client) {
    showToast('Live capture settings saved. Stop and resume capture to apply them.', 4500);
    return;
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
  elements.menuButton?.addEventListener('click', openSidebar);
  elements.sidebarClose?.addEventListener('click', closeSidebar);
  elements.backdrop?.addEventListener('click', closeSidebar);

  document.body.addEventListener('click', async (event) => {
    if (event.target.closest('#menuButton')) {
      openSidebar();
      return;
    }

    if (event.target.closest('#sidebarClose') || event.target.closest('#backdrop')) {
      closeSidebar();
      return;
    }

    const navButton = event.target.closest('[data-route]');
    if (navButton) {
      if (navButton.dataset.route === 'setup' && state.currentSession && state.currentSession.status !== 'ended') {
        await createFreshSessionFromLive();
        return;
      }
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
  elements.themeSelect.addEventListener('change', async () => {
    const nextTheme = normalizeTheme(elements.themeSelect.value);
    if (nextTheme === normalizeTheme(state.settings.theme)) return;
    await persistSettings({ theme: nextTheme });
    renderCurrentView();
    showToast(`Theme set to ${nextTheme}.`);
  });

  elements.toggleApiKey.addEventListener('click', () => togglePasswordVisibility(elements.apiKeyInput, elements.toggleApiKey));
  elements.settingsToggleApiKey.addEventListener('click', () => togglePasswordVisibility(elements.settingsApiKeyInput, elements.settingsToggleApiKey));

  elements.resumeLastSessionButton.addEventListener('click', resumeLastSession);
  elements.recoverDraftButton.addEventListener('click', resumeLastSession);
  elements.openHistoryFromSetup.addEventListener('click', () => setRoute('history'));
  elements.openMicSettingsButton?.addEventListener('click', openMicrophoneSettings);
  elements.refreshMicDevicesButton?.addEventListener('click', () => {
    refreshMicrophoneOptions().catch(() => {});
  });
  elements.settingsRefreshMicDevicesButton?.addEventListener('click', () => {
    refreshMicrophoneOptions().catch(() => {});
  });
  elements.refreshHistoryButton.addEventListener('click', refreshSessions);
  getTranscriptViewButtons().forEach((button) => {
    button.addEventListener('click', () => setTranscriptView(button.dataset.transcriptView));
  });
  elements.jumpToLiveButton?.addEventListener('click', () => scrollTranscriptToLive());
  elements.finalizeSpeakerButton?.addEventListener('click', finalizeSpeakerTiming);
  elements.transcriptHistoryDetails?.addEventListener('toggle', () => {
    if (elements.transcriptHistoryDetails.open && state.settings.autoScroll) {
      requestAnimationFrame(() => {
        if (elements.transcriptList) {
          elements.transcriptList.scrollTop = Math.max(0, elements.transcriptList.scrollHeight - elements.transcriptList.clientHeight);
        }
        updateTranscriptAutoFollowState();
      });
      return;
    }
    updateTranscriptAutoFollowState();
  });
  elements.transcriptList.addEventListener('scroll', updateTranscriptAutoFollowState);
  elements.transcriptList.addEventListener('click', async (event) => {
    const row = event.target.closest('.transcript-pair[data-start-ms]');
    if (!row) return;
    const startMs = Number(row.dataset.startMs || 0);
    const played = await playSessionAudioAtMs(startMs, { userGesture: true });
    if (!played) {
      showToast('No saved audio clip covers that part yet.');
    }
  });
  window.addEventListener('resize', applyTranscriptView);
  elements.reviewPlayPauseButton?.addEventListener('click', toggleReviewAudioPlayback);
  elements.reviewStopButton?.addEventListener('click', () => {
    stopReviewAudio({ resetToStart: true }).catch((error) => console.warn('Unable to stop whole-session playback', error));
  });
  elements.reviewProgressInput?.addEventListener('input', (event) => {
    const nextValue = Number(event.target.value || 0);
    setSessionPlaybackPreviewMs(nextValue);
  });
  elements.reviewProgressInput?.addEventListener('change', () => {
    commitReviewAudioSeekFromControl({ userGesture: true }).catch((error) => console.warn('Unable to seek whole-session playback', error));
  });
  elements.reviewProgressInput?.addEventListener('pointerup', () => {
    commitReviewAudioSeekFromControl({ userGesture: true }).catch((error) => console.warn('Unable to seek whole-session playback', error));
  });
  elements.reviewJumpBack5mButton?.addEventListener('click', () => {
    seekSessionAudioByDeltaMs(-5 * 60 * 1000, { autoplay: true, userGesture: true }).catch((error) =>
      console.warn('Unable to seek backward 5 minutes', error)
    );
  });
  elements.reviewJumpBack30Button?.addEventListener('click', () => {
    seekSessionAudioByDeltaMs(-30 * 1000, { autoplay: true, userGesture: true }).catch((error) =>
      console.warn('Unable to seek backward 30 seconds', error)
    );
  });
  elements.reviewJumpForward30Button?.addEventListener('click', () => {
    seekSessionAudioByDeltaMs(30 * 1000, { autoplay: true, userGesture: true }).catch((error) =>
      console.warn('Unable to seek forward 30 seconds', error)
    );
  });
  elements.reviewJumpForward5mButton?.addEventListener('click', () => {
    seekSessionAudioByDeltaMs(5 * 60 * 1000, { autoplay: true, userGesture: true }).catch((error) =>
      console.warn('Unable to seek forward 5 minutes', error)
    );
  });
  elements.reviewAudio?.addEventListener('timeupdate', () => {
    updatePlaybackHighlight({ shouldScroll: true });
    renderRecordingReview();
  });
  elements.reviewAudio?.addEventListener('play', () => {
    state.sessionPlaybackPreviewMs = null;
    state.reviewAudioFloatingActive = true;
    renderRecordingReview();
    updateSpeakerPlaybackIndicator();
  });
  elements.reviewAudio?.addEventListener('pause', () => {
    state.reviewAudioFloatingActive = false;
    renderRecordingReview();
    updateSpeakerPlaybackIndicator();
  });
  elements.reviewAudio?.addEventListener('ended', async () => {
    state.sessionPlaybackPreviewMs = null;
    state.reviewAudioFloatingActive = false;
    const nextIndex = state.sessionPlaybackClipIndex + 1;
    if (nextIndex < state.sessionRecordings.length) {
      await loadRecordingClip(nextIndex, { autoplay: true });
      return;
    }
    renderRecordingReview();
    updatePlaybackHighlight();
    updateSpeakerPlaybackIndicator();
  });
  elements.speakerChangeButton?.addEventListener('click', () => {
    const mode = elements.speakerChangeButton?.dataset.mode || 'mark';
    const action = mode === 'reset' ? resetManualSpeakerChanges() : markManualSpeakerChange();
    action.catch((error) => console.warn('Unable to handle manual speaker action', error));
  });
  elements.speakerChangePauseButton?.addEventListener('click', () => {
    const mode = elements.speakerChangePauseButton?.dataset.mode || 'resume';
    const action = mode === 'stop' ? pauseManualSpeakerTimer() : resumeManualSpeakerTimer();
    action.catch((error) => console.warn('Unable to update manual speaker timer', error));
  });
  elements.speakerChangeResetButton?.addEventListener('click', () => {
    resetManualSpeakerChanges().catch((error) => console.warn('Unable to reset manual speaker changes', error));
  });
  const handleManualSpeakerCurrentSelectChange = () => {
    applyManualSpeakerSelectionFromControl().catch((error) => console.warn('Unable to update current speaker selection', error));
  };
  elements.speakerChangeCurrentSelect?.addEventListener('input', handleManualSpeakerCurrentSelectChange);
  elements.speakerChangeCurrentSelect?.addEventListener('change', handleManualSpeakerCurrentSelectChange);
  elements.speakerChangeCustomInput?.addEventListener('input', () => {
    state.manualSpeakerCustomNameDraft = elements.speakerChangeCustomInput.value;
    if (elements.speakerChangeCustomUseButton) {
      elements.speakerChangeCustomUseButton.disabled =
        !state.currentSession ||
        state.currentSession.status === 'ended' ||
        !normalizeManualSpeakerName(state.manualSpeakerCustomNameDraft);
    }
  });
  elements.speakerChangeCustomInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    useManualSpeakerCustomName().catch((error) => console.warn('Unable to use custom speaker name', error));
  });
  elements.speakerChangeCustomUseButton?.addEventListener('click', () => {
    useManualSpeakerCustomName().catch((error) => console.warn('Unable to use custom speaker name', error));
  });
  elements.speakerChangeMarkers?.addEventListener('click', async (event) => {
    const choiceButton = event.target.closest('[data-speaker-marker-choice-id]');
    if (choiceButton) {
      const markerId = String(choiceButton.dataset.speakerMarkerChoiceId || '').trim();
      const nextSpeakerLabel = String(choiceButton.dataset.speakerLabel || '').trim();
      const index = state.manualSpeakerEvents.findIndex(
        (item, itemIndex) => getManualSpeakerEntryId(item, itemIndex) === markerId
      );
      if (!Number.isInteger(index) || index < 0 || !state.manualSpeakerEvents[index] || !nextSpeakerLabel) return;
      state.manualSpeakerEvents[index] = {
        ...state.manualSpeakerEvents[index],
        speakerLabel: nextSpeakerLabel,
      };
      state.manualSpeakerEditingEventId = '';
      await applyManualSpeakerEventsToCurrentSession().catch((error) => console.warn('Unable to apply manual speaker labels', error));
      return;
    }

    if (event.target.closest('.speaker-change-marker-row__editor')) {
      return;
    }

    const toggleButton = event.target.closest('[data-speaker-marker-toggle-id]');
    if (toggleButton) {
      const nextId = String(toggleButton.dataset.speakerMarkerToggleId || '').trim();
      state.manualSpeakerEditingEventId = state.manualSpeakerEditingEventId === nextId ? '' : nextId;
      renderManualSpeakerControls();
      return;
    }

    const playButton = event.target.closest('[data-speaker-marker-play-ms]');
    if (!playButton) return;
    const startMs = Number(playButton.dataset.speakerMarkerPlayMs || 0);
    const played = await playSessionAudioAtMs(startMs);
    if (!played) {
      showToast('No saved audio clip covers that speaker mark yet.');
    }
  });
  elements.startButton.addEventListener('click', () => {
    const mode = elements.startButton?.dataset.mode || 'start';
    const action = mode === 'stop' ? stopListening() : startListening();
    action.catch((error) => console.warn('Unable to update session capture state', error));
  });
  elements.pauseButton.addEventListener('click', pauseListening);
  elements.resumeButton.addEventListener('click', () => startListening());
  elements.stopButton.addEventListener('click', stopListening);
  elements.endSessionButton.addEventListener('click', endCurrentSession);
  elements.newSessionButton.addEventListener('click', createFreshSessionFromLive);
  elements.renameSessionButton.addEventListener('click', renameCurrentSession);
  elements.speakerSummary.addEventListener('click', async (event) => {
    const playSlotButton = event.target.closest('[data-speaker-action="play-slot"]');
    if (playSlotButton) {
      const startMs = Number(playSlotButton.dataset.startMs || 0);
      const played = await playSessionAudioAtMs(startMs);
      if (!played) {
        showToast('No saved audio clip covers that speaker slot yet.');
      }
      return;
    }

    const playSpeakerButton = event.target.closest('[data-speaker-action="play-speaker"]');
    if (playSpeakerButton) {
      const startMs = Number(playSpeakerButton.dataset.startMs || 0);
      const played = await playSessionAudioAtMs(startMs);
      if (!played) {
        showToast('No saved audio clip covers that speaker yet.');
      }
      return;
    }

    const playSegmentButton = event.target.closest('[data-speaker-action="play-segment"]');
    if (playSegmentButton) {
      const startMs = Number(playSegmentButton.dataset.startMs || 0);
      const played = await playSessionAudioAtMs(startMs);
      if (!played) {
        showToast('No saved audio clip covers that line yet.');
      }
      return;
    }

    const toggleButton = event.target.closest('[data-speaker-action="toggle"]');
    if (toggleButton) {
      toggleSpeakerSummaryExpansion(toggleButton.dataset.speakerKey);
      return;
    }

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

  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    refreshMicrophoneOptions({ silent: true }).catch(() => {});
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
    stopSpeakerTracking({ statusMessage: 'Leaving the page. Speaker timing paused.' }).catch(() => {});
    stopSessionRecording().catch(() => {});
    ensureScreenWakeLock(false).catch(() => {});
    if (state.currentSession && state.currentSession.status !== 'ended' && ['listening', 'connecting', 'reconnecting'].includes(state.runtimeStatus)) {
      state.currentSession.runtimeStatus = 'stopped';
      state.currentSession.status = 'paused';
    }
    persistCurrentSessionNow().catch(() => {});
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.wakeLockWanted) {
      requestScreenWakeLock().catch(() => {});
    }
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
  await refreshMicrophoneOptions({ silent: true });

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
  const transcriptListText = elements.transcriptList?.innerText || '';
  const liveBandText = elements.transcriptLiveBand?.innerText || '';
  return {
    sourceDraft: elements.sourceDraftText?.textContent || '',
    sourceState: elements.sourceDraftState?.textContent || '',
    sourceCarry: elements.sourceDraftCarryText?.textContent || '',
    targetDraft: elements.targetDraftText?.textContent || '',
    targetState: elements.targetDraftState?.textContent || '',
    targetCarry: elements.targetDraftCarryText?.textContent || '',
    status: elements.statusLine?.textContent || '',
    statusLine: elements.statusLine?.textContent || '',
    liveState: elements.transcriptLiveState?.textContent || '',
    route: state.route,
    runtimeStatus: state.runtimeStatus,
    realtimeTranscriptionModel: state.settings.realtimeTranscriptionModel,
    clientTranscriptionModel: state.client?.transcriptionModel || '',
    segmentCount: state.currentSegments.length,
    segmentMetricLabel: elements.segmentCountLabel?.textContent || '',
    segmentMetricValue: elements.segmentCountValue?.textContent || '',
    segmentMetricMeta: elements.segmentCountMeta?.textContent || '',
    speakerStatusLine: elements.speakerStatusLine?.textContent || '',
    finalizeSpeakerButton: elements.finalizeSpeakerButton?.textContent || '',
    speakerFinalizeProgress: state.speakerFinalizeProgress,
    speakerSummaryText: elements.speakerSummary?.innerText || '',
    transcriptText: transcriptListText,
    transcriptTail: transcriptListText.slice(-1600),
    liveBandText,
    liveBandTail: liveBandText.slice(-1600),
  };
}

function setDebugSegments(segments = []) {
  if (!state.currentSession) return buildDebugSnapshot();

  const sessionId = state.currentSession.id;
  state.currentSegments = (Array.isArray(segments) ? segments : []).map((segment, index) => {
    const startMs = Number(segment?.startMs ?? index * 4000);
    const endMs = Number(segment?.endMs ?? startMs + 2500);
    return {
      id: segment?.id || `${sessionId}:debug-segment-${index + 1}`,
      sessionId,
      sequence: Number(segment?.sequence ?? index + 1),
      startMs,
      endMs,
      speechEndMs: Number(segment?.speechEndMs ?? endMs),
      sourceLanguage: segment?.sourceLanguage || state.currentSession.sourceLanguage,
      targetLanguage: segment?.targetLanguage || state.currentSession.targetLanguage,
      sourceText: String(segment?.sourceText || '').trim(),
      translatedText: String(segment?.translatedText || '').trim(),
      translatedDraft: String(segment?.translatedDraft || '').trim(),
      translationStatus: segment?.translationStatus || 'done',
      speakerRawLabel: segment?.speakerRawLabel || '',
      speakerLabel: segment?.speakerLabel || '',
      speakerStatus: segment?.speakerStatus || 'done',
      speakerDurationMs: Number(segment?.speakerDurationMs ?? Math.max(1000, endMs - startMs)),
      createdAt: segment?.createdAt || nowIso(),
    };
  });
  state.currentSession.segmentCount = state.currentSegments.length;
  renderCurrentView();
  return buildDebugSnapshot();
}

function setDebugSpeakerState(partial = {}) {
  if (Object.prototype.hasOwnProperty.call(partial, 'speakerSummaryExpandedKeys')) {
    state.speakerSummaryExpandedKeys = new Set(partial.speakerSummaryExpandedKeys || []);
  }

  Object.entries(partial || {}).forEach(([key, value]) => {
    if (key === 'speakerSummaryExpandedKeys') return;
    state[key] = value;
  });

  renderCurrentView();
  return buildDebugSnapshot();
}

function setDebugCurrentSession(partial = {}) {
  if (!state.currentSession) return buildDebugSnapshot();
  state.currentSession = {
    ...state.currentSession,
    ...(partial || {}),
  };
  if (Object.prototype.hasOwnProperty.call(partial || {}, 'manualSpeakerEvents')) {
    state.manualSpeakerEvents = normalizeManualSpeakerSegments(partial.manualSpeakerEvents, state.currentSession);
  }
  if (Object.prototype.hasOwnProperty.call(partial || {}, 'manualSpeakerOpenStartMs')) {
    state.manualSpeakerOpenStartMs = partial.manualSpeakerOpenStartMs === null ? null : Math.max(0, Number(partial.manualSpeakerOpenStartMs || 0));
  }
  if (Object.prototype.hasOwnProperty.call(partial || {}, 'manualSpeakerActiveLabel')) {
    state.manualSpeakerActiveLabel = String(partial.manualSpeakerActiveLabel || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(partial || {}, 'manualSpeakerBaseOffsetMs')) {
    state.manualSpeakerBaseOffsetMs = Number(partial.manualSpeakerBaseOffsetMs || 0);
  }
  if (Object.prototype.hasOwnProperty.call(partial || {}, 'manualSpeakerElapsedMs')) {
    state.manualSpeakerElapsedMs = Math.max(0, Number(partial.manualSpeakerElapsedMs || 0));
  }
  if (Object.prototype.hasOwnProperty.call(partial || {}, 'manualSpeakerPaused')) {
    state.manualSpeakerPaused = partial.manualSpeakerPaused !== false;
  }
  if (Object.prototype.hasOwnProperty.call(partial || {}, 'manualSpeakerCurrentLabel')) {
    state.manualSpeakerCurrentLabel = String(partial.manualSpeakerCurrentLabel || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(partial || {}, 'manualSpeakerPendingChangeAtMs')) {
    state.manualSpeakerPendingChangeAtMs = partial.manualSpeakerPendingChangeAtMs === null ? null : Number(partial.manualSpeakerPendingChangeAtMs || 0);
  }
  renderCurrentView();
  return buildDebugSnapshot();
}

async function setDebugRecordings(recordings = []) {
  if (!state.currentSession) return buildDebugSnapshot();

  const sessionId = state.currentSession.id;
  const normalized = await Promise.all(
    (Array.isArray(recordings) ? recordings : []).map(async (recording, index) => {
      const startMs = Number(recording?.startMs ?? index * 60000);
      const endMs = Number(recording?.endMs ?? startMs + 60000);
      const blob =
        recording?.blob instanceof Blob
          ? recording.blob
          : new Blob([recording?.bytes || new Uint8Array()], { type: recording?.mimeType || 'audio/wav' });
      const normalizedRecording = {
        id: recording?.id || `${sessionId}:debug-recording-${index + 1}`,
        sessionId,
        startMs,
        endMs,
        mimeType: recording?.mimeType || blob.type || 'audio/wav',
        blob,
        diarizedAt: recording?.diarizedAt || '',
        createdAt: recording?.createdAt || nowIso(),
      };
      await upsertRecording(normalizedRecording);
      return normalizedRecording;
    })
  );

  state.sessionRecordings = normalized;
  renderCurrentView();
  return buildDebugSnapshot();
}

function setDebugDiarizeMock(mock = null) {
  state.debugDiarizeAudioChunk = typeof mock === 'function' ? mock : null;
  return buildDebugSnapshot();
}

async function runDebugFinalizeSpeakerTiming() {
  await finalizeSpeakerTiming();
  return buildDebugSnapshot();
}

async function persistDebugSettings(partial = {}) {
  debugNoPersistence = true;
  await persistSettings({
    ...state.settings,
    ...partial,
  });
  renderCurrentView();
  return buildDebugSnapshot();
}

async function createDebugSession({
  sourceLanguage = state.settings.sourceLanguage || 'en',
  targetLanguage = state.settings.targetLanguage || 'de',
  glossary = state.settings.glossary || '',
  speakerNames = state.settings.speakerNames || '',
} = {}) {
  debugNoPersistence = true;
  const createdAt = nowIso();
  const session = {
    id: crypto.randomUUID(),
    title: buildSessionTitle(createdAt, sourceLanguage, targetLanguage),
    status: 'paused',
    runtimeStatus: 'idle',
    sourceLanguage,
    targetLanguage,
    glossary: glossary || '',
    speakerNames: normalizeSpeakerNamesInput(speakerNames),
    speakerAliases: {},
    createdAt,
    updatedAt: createdAt,
    activeDurationMs: 0,
    speechOnlyMs: 0,
    segmentCount: 0,
    draftSource: '',
    draftTranslation: '',
    lastSequence: 0,
    manualSpeakerEvents: [],
    manualSpeakerOpenStartMs: null,
    manualSpeakerActiveLabel: '',
    manualSpeakerBaseOffsetMs: 0,
    manualSpeakerElapsedMs: 0,
    manualSpeakerPaused: true,
    manualSpeakerCurrentLabel: '',
    manualSpeakerPendingChangeAtMs: null,
    speakerFinalizedAt: '',
  };
  state.currentSession = session;
  state.sessions = [session, ...state.sessions.filter((item) => item.id !== session.id)];
  state.currentSegments = [];
  state.sessionRecordings = [];
  state.manualSpeakerEvents = [];
  state.manualSpeakerOpenStartMs = null;
  state.manualSpeakerActiveLabel = '';
  state.manualSpeakerBaseOffsetMs = 0;
  state.manualSpeakerElapsedMs = 0;
  state.manualSpeakerPaused = true;
  state.manualSpeakerPendingChangeAtMs = null;
  state.speakerFinalizeProgress = null;
  state.manualSpeakerCurrentLabel = getSpeakerOptionsForManualControls(session)[0] || 'Speaker A';
  state.manualSpeakerCustomNameDraft = '';
  state.transcriptPinnedToBottom = true;
  clearLiveDraftCarry();
  await syncLastActiveSession();
  renderCurrentView();
  setRoute('live');
  return buildDebugSnapshot();
}

async function startListeningForDebug(options = {}) {
  debugNoPersistence = true;
  await startListening(options);
  return buildDebugSnapshot();
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
  state.currentSession.speakerFinalizedAt = '';
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
    persistSettingsForTest: persistDebugSettings,
    createSessionForTest: createDebugSession,
    startListeningForTest: startListeningForDebug,
    setSegmentsForTest: setDebugSegments,
    setSpeakerStateForTest: setDebugSpeakerState,
    setCurrentSessionForTest: setDebugCurrentSession,
    setRecordingsForTest: setDebugRecordings,
    setDiarizeMockForTest: setDebugDiarizeMock,
    runFinalizeSpeakerTimingForTest: runDebugFinalizeSpeakerTiming,
    getRealtimeClientPreviewForTest: getRealtimeClientPreview,
    getViewForTest: buildDebugSnapshot,
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
  populateRealtimeTranscriptionModelSelect(elements.realtimeTranscriptionModelInput);
  populateRealtimeTranscriptionModelSelect(elements.settingsRealtimeTranscriptionModelInput);
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
