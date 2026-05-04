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
import { RealtimeTranscriptionClient, translateText } from './openai.js';

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
  draftByItemId: new Map(),
  commitMetaByItemId: new Map(),
  draftTranslationTimer: null,
  draftTranslationPending: null,
  draftTranslationInFlight: false,
  draftTranslationLastStartedAt: 0,
  finalTranslationQueue: Promise.resolve(),
  finalTranslationInFlight: false,
  sessionPersistTimer: null,
  clockTimer: null,
  installPrompt: null,
  activeDraftItemId: null,
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
  sourceDraftLabel: $('#sourceDraftLabel'),
  sourceDraftText: $('#sourceDraftText'),
  sourceDraftState: $('#sourceDraftState'),
  targetDraftLabel: $('#targetDraftLabel'),
  targetDraftText: $('#targetDraftText'),
  targetDraftState: $('#targetDraftState'),
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
  elements.topbarEyebrow.textContent = status === 'listening' ? 'Live capture' : 'Transcriptor';

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
  elements.settingsGlossaryInput.value = settings.glossary || '';
  elements.textSizeSelect.value = settings.textSize || 'medium';
  elements.autoScrollInput.checked = Boolean(settings.autoScroll);
  elements.timestampStyleSelect.value = settings.timestampStyle || 'elapsed';
  elements.toggleAutoScrollButton.textContent = `Auto-scroll: ${settings.autoScroll ? 'On' : 'Off'}`;
  document.body.classList.remove('text-size-small', 'text-size-medium', 'text-size-large', 'text-size-xlarge');
  document.body.classList.add(`text-size-${settings.textSize || 'medium'}`);
  elements.transcriptList.classList.remove('text-size-small', 'text-size-medium', 'text-size-large', 'text-size-xlarge');
  elements.transcriptList.classList.add(`text-size-${settings.textSize || 'medium'}`);
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
  };
}

function collectSettingsFromSettingsForm() {
  return {
    apiKey: elements.settingsApiKeyInput.value.trim(),
    sourceLanguage: elements.settingsSourceLanguage.value,
    targetLanguage: elements.settingsTargetLanguage.value,
    glossary: elements.settingsGlossaryInput.value.trim(),
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

function renderDrafts() {
  const session = state.currentSession;
  const sourceLanguage = session ? getLanguageName(session.sourceLanguage) : 'Source';
  const targetLanguage = session ? getLanguageName(session.targetLanguage) : 'Target';
  elements.sourceDraftLabel.textContent = `${sourceLanguage} draft`;
  elements.targetDraftLabel.textContent = `${targetLanguage} draft`;

  const sourceDraft = session?.draftSource?.trim();
  const targetDraft = session?.draftTranslation?.trim();
  const activeDraftPending = Boolean(
    sourceDraft &&
      ((state.draftTranslationPending && state.draftTranslationPending.itemId === state.activeDraftItemId) ||
        state.draftTranslationInFlight)
  );

  elements.sourceDraftText.textContent = sourceDraft || 'No live source-language draft yet.';
  elements.targetDraftText.textContent =
    targetDraft || (activeDraftPending ? 'Translation is catching up…' : 'No live translation draft yet.');
  elements.sourceDraftState.textContent = sourceDraft ? 'Updating' : 'Waiting';
  elements.targetDraftState.textContent = targetDraft
    ? activeDraftPending
      ? 'Refreshing'
      : 'Live'
    : activeDraftPending
      ? 'Translating'
      : 'Waiting';
}

function renderTranscript() {
  if (!state.currentSegments.length) {
    elements.transcriptList.innerHTML = '<div class="note">No finalized transcript segments yet.</div>';
    return;
  }

  const sourceLabel = getLanguageName(state.currentSession?.sourceLanguage);
  const targetLabel = getLanguageName(state.currentSession?.targetLanguage);
  elements.transcriptList.innerHTML = state.currentSegments
    .map((segment) => {
      const translatedDisplay = segment.translatedText?.trim()
        ? segment.translatedText
        : segment.translationStatus === 'error'
          ? 'Translation unavailable.'
          : 'Translating…';

      return `
        <article class="transcript-entry">
          <div class="transcript-entry__header">
            <strong>${buildTranscriptTimestamp(segment)}</strong>
            <span class="transcript-entry__meta">Segment ${segment.sequence || ''}</span>
          </div>
          <div class="transcript-entry__columns">
            <div>
              <span class="transcript-entry__label">${sourceLabel}</span>
              <p class="transcript-entry__text">${escapeHtml(segment.sourceText)}</p>
            </div>
            <div>
              <span class="transcript-entry__label">${targetLabel}</span>
              <p class="transcript-entry__text">${escapeHtml(translatedDisplay)}</p>
            </div>
          </div>
        </article>
      `;
    })
    .join('');

  if (state.settings.autoScroll) {
    requestAnimationFrame(() => {
      elements.transcriptList.scrollTop = elements.transcriptList.scrollHeight;
    });
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

async function createSession({ sourceLanguage, targetLanguage, glossary }) {
  const createdAt = nowIso();
  const session = {
    id: crypto.randomUUID(),
    title: buildSessionTitle(createdAt, sourceLanguage, targetLanguage),
    status: 'paused',
    runtimeStatus: 'idle',
    sourceLanguage,
    targetLanguage,
    glossary: glossary || '',
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
  state.draftByItemId.clear();
  state.commitMetaByItemId.clear();
  state.activeDraftItemId = null;
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
  renderTranscript();
  renderHistory();
  renderControls();
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
    await state.client.disconnect({ nextStatus: 'stopped', message: 'Resetting the live connection...' });
    state.client = null;
  }

  setStatus('connecting', 'Requesting microphone access and opening a live transcription connection...');
  state.currentSession.status = 'active';
  state.currentSession.runtimeStatus = 'connecting';
  state.currentSession.updatedAt = nowIso();
  await persistCurrentSessionNow();
  await syncLastActiveSession();

  const client = new RealtimeTranscriptionClient({
    apiKey: state.settings.apiKey,
    sourceLanguage: state.currentSession.sourceLanguage,
    sourceLanguageName: getLanguageName(state.currentSession.sourceLanguage),
    targetLanguageName: getLanguageName(state.currentSession.targetLanguage),
    glossary: state.currentSession.glossary || state.settings.glossary,
    onEvent: handleRealtimeEvent,
    onStatus: (status, message) => {
      if (status === 'listening') {
        markListeningStart();
      }
      setStatus(status, message);
      renderSessionSummary();
    },
    onError: async (message) => {
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
    state.client = null;
    const message = error?.message || 'Unable to start live transcription.';
    setStatus('error', message);
    showToast(message, 5000);
  }
}

async function pauseListening() {
  if (!state.client) return;
  flushListeningClock();
  flushSpeechClock();
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
    flushListeningClock();
    flushSpeechClock();
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
    flushListeningClock();
    flushSpeechClock();
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
  const current = state.draftByItemId.get(itemId) || { sourceDraft: '', translatedDraft: '' };
  current.sourceDraft = `${current.sourceDraft || ''}${delta || ''}`;
  state.draftByItemId.set(itemId, current);
  state.activeDraftItemId = itemId;
  if (state.currentSession) {
    state.currentSession.draftSource = current.sourceDraft.trim();
  }
  renderDrafts();
  scheduleSessionPersist(400);
  scheduleDraftTranslation(itemId, current.sourceDraft.trim());
}

function clearDraftState(itemId) {
  state.draftByItemId.delete(itemId);
  if (state.draftTranslationPending?.itemId === itemId) {
    state.draftTranslationPending = null;
    window.clearTimeout(state.draftTranslationTimer);
  }
  if (state.activeDraftItemId === itemId) {
    state.activeDraftItemId = null;
  }
  if (state.currentSession && state.activeDraftItemId === null) {
    state.currentSession.draftSource = '';
    state.currentSession.draftTranslation = '';
  }
  renderDrafts();
}

function scheduleDraftTranslation(itemId, text) {
  if (!state.currentSession) return;

  const trimmedText = text.trim();
  if (!trimmedText || trimmedText.length < 8) {
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
  processDraftTranslationQueue();
}

function processDraftTranslationQueue() {
  if (!state.currentSession || !state.draftTranslationPending) return;
  if (state.draftTranslationInFlight || state.finalTranslationInFlight) return;

  const waitMs = Math.max(0, 1200 - (Date.now() - state.draftTranslationLastStartedAt));
  window.clearTimeout(state.draftTranslationTimer);
  state.draftTranslationTimer = window.setTimeout(async () => {
    const snapshot = state.draftTranslationPending;
    if (!snapshot || !state.currentSession || state.finalTranslationInFlight) return;

    state.draftTranslationInFlight = true;
    state.draftTranslationLastStartedAt = Date.now();
    renderDrafts();

    try {
      const translated = await translateText({
        apiKey: state.settings.apiKey,
        sourceLanguageName: getLanguageName(state.currentSession.sourceLanguage),
        targetLanguageName: getLanguageName(state.currentSession.targetLanguage),
        glossary: state.currentSession.glossary || state.settings.glossary,
        sourceText: snapshot.text,
        draft: true,
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
      console.warn('Draft translation failed', error);
      const isStillLatest =
        state.draftTranslationPending &&
        state.draftTranslationPending.itemId === snapshot.itemId &&
        state.draftTranslationPending.text === snapshot.text;
      if (isStillLatest) {
        state.draftTranslationPending = null;
      }
    } finally {
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
    glossary: state.currentSession?.glossary || state.settings.glossary,
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
    clearDraftState(itemId);
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
    createdAt: commitMeta.committedAtIso || nowIso(),
  };

  upsertCurrentSegmentInState(segment);
  await upsertSegment(segment);
  clearDraftState(itemId);
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
    markSpeechStart();
    return;
  }

  if (event.type === 'input_audio_buffer.speech_stopped') {
    flushSpeechClock();
    renderSessionSummary();
    scheduleSessionPersist();
    return;
  }

  if (event.type === 'input_audio_buffer.committed') {
    buildCommitMeta(event.item_id, event.previous_item_id);
    return;
  }

  if (event.type === 'conversation.item.input_audio_transcription.delta') {
    updateDraft(event.item_id, event.delta || '');
    return;
  }

  if (event.type === 'conversation.item.input_audio_transcription.completed') {
    flushSpeechClock();
    finalizeSegmentFromEvent(event).catch((error) => {
      console.error('Segment finalization failed', error);
      showToast(error?.message || 'A segment failed to finalize.', 5000);
    });
    return;
  }

  if (event.type === 'transcriptor.rollover.requested') {
    await rolloverConnection();
  }
}

async function rolloverConnection() {
  if (!state.currentSession || !state.client) return;
  showToast('Refreshing the live connection to keep the session healthy...');
  flushListeningClock();
  flushSpeechClock();
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

async function renameCurrentSession() {
  if (!state.currentSession) return;
  const nextTitle = window.prompt('Rename session', state.currentSession.title);
  if (!nextTitle || !nextTitle.trim()) return;
  state.currentSession.title = nextTitle.trim();
  await persistCurrentSessionNow();
  await refreshSessions();
  renderCurrentView();
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
  if (state.currentSession) {
    state.currentSession.sourceLanguage = values.sourceLanguage;
    state.currentSession.targetLanguage = values.targetLanguage;
    state.currentSession.glossary = values.glossary;
    state.currentSession.updatedAt = nowIso();
    await persistCurrentSessionNow();
  }
  renderCurrentView();
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

  elements.startButton.addEventListener('click', () => startListening());
  elements.pauseButton.addEventListener('click', pauseListening);
  elements.resumeButton.addEventListener('click', () => startListening());
  elements.stopButton.addEventListener('click', stopListening);
  elements.endSessionButton.addEventListener('click', endCurrentSession);
  elements.newSessionButton.addEventListener('click', createFreshSessionFromLive);
  elements.renameSessionButton.addEventListener('click', renameCurrentSession);

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
  await loadBootstrapData();
  renderCurrentView();
  startClockTimer();
  await registerServiceWorker();
}

init().catch((error) => {
  console.error(error);
  showToast(error?.message || 'Transcriptor failed to load.', 6000);
});
