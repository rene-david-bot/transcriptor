const DB_NAME = 'transcriptor-db';
const DB_VERSION = 1;
const LOCAL_SETTINGS_KEY = 'transcripto-ui-settings';

const LOCAL_SETTINGS_FIELDS = [
  'sourceLanguage',
  'targetLanguage',
  'glossary',
  'speakerNames',
  'autoScroll',
  'textSize',
  'timestampStyle',
  'theme',
];

let dbPromise;

function canUseLocalStorage() {
  return typeof localStorage !== 'undefined';
}

function pickLocalSettings(settings = {}) {
  return LOCAL_SETTINGS_FIELDS.reduce((picked, key) => {
    if (settings[key] === undefined) return picked;
    picked[key] = settings[key];
    return picked;
  }, {});
}

function readLocalSettings() {
  if (!canUseLocalStorage()) return null;
  try {
    const raw = localStorage.getItem(LOCAL_SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeLocalSettings(settings = {}) {
  if (!canUseLocalStorage()) return;
  try {
    localStorage.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(pickLocalSettings(settings)));
  } catch {
    // Ignore quota / availability issues. IndexedDB remains the primary durable store.
  }
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function openDatabase() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('sessions')) {
        const store = db.createObjectStore('sessions', { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
        store.createIndex('status', 'status');
      }

      if (!db.objectStoreNames.contains('segments')) {
        const store = db.createObjectStore('segments', { keyPath: 'id' });
        store.createIndex('sessionId', 'sessionId');
        store.createIndex('sessionId_sequence', ['sessionId', 'sequence']);
      }

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });

  return dbPromise;
}

function txComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

export async function getSettings() {
  const localSettings = readLocalSettings();
  const db = await openDatabase();
  const tx = db.transaction('settings', 'readonly');
  const record = await requestToPromise(tx.objectStore('settings').get('app'));
  await txComplete(tx);
  return {
    ...(record?.value || {}),
    ...(localSettings || {}),
  };
}

export async function saveSettings(settings) {
  writeLocalSettings(settings);
  openDatabase()
    .then((db) => {
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({ id: 'app', value: settings, updatedAt: new Date().toISOString() });
      return txComplete(tx);
    })
    .catch((error) => {
      console.warn('IndexedDB settings save failed, using local settings mirror.', error);
    });
  return settings;
}

export async function getMeta(id) {
  const db = await openDatabase();
  const tx = db.transaction('meta', 'readonly');
  const record = await requestToPromise(tx.objectStore('meta').get(id));
  await txComplete(tx);
  return record?.value;
}

export async function setMeta(id, value) {
  const db = await openDatabase();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ id, value, updatedAt: new Date().toISOString() });
  await txComplete(tx);
}

export async function deleteMeta(id) {
  const db = await openDatabase();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').delete(id);
  await txComplete(tx);
}

export async function upsertSession(session) {
  const db = await openDatabase();
  const tx = db.transaction('sessions', 'readwrite');
  tx.objectStore('sessions').put(session);
  await txComplete(tx);
  return session;
}

export async function getSession(sessionId) {
  const db = await openDatabase();
  const tx = db.transaction('sessions', 'readonly');
  const record = await requestToPromise(tx.objectStore('sessions').get(sessionId));
  await txComplete(tx);
  return record || null;
}

export async function listSessions() {
  const db = await openDatabase();
  const tx = db.transaction('sessions', 'readonly');
  const sessions = await requestToPromise(tx.objectStore('sessions').getAll());
  await txComplete(tx);
  return sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function deleteSession(sessionId) {
  const db = await openDatabase();
  const tx = db.transaction(['sessions', 'segments'], 'readwrite');
  tx.objectStore('sessions').delete(sessionId);
  const index = tx.objectStore('segments').index('sessionId');
  const range = IDBKeyRange.only(sessionId);
  const request = index.openCursor(range);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
  await txComplete(tx);
}

export async function deleteEndedSessions() {
  const sessions = await listSessions();
  const ended = sessions.filter((session) => session.status === 'ended');
  for (const session of ended) {
    await deleteSession(session.id);
  }
  return ended.length;
}

export async function clearAllSessions() {
  const db = await openDatabase();
  const tx = db.transaction(['sessions', 'segments', 'meta'], 'readwrite');
  tx.objectStore('sessions').clear();
  tx.objectStore('segments').clear();
  tx.objectStore('meta').delete('lastActiveSessionId');
  tx.objectStore('meta').delete('resumeHintDismissed');
  await txComplete(tx);
}

export async function upsertSegment(segment) {
  const db = await openDatabase();
  const tx = db.transaction('segments', 'readwrite');
  tx.objectStore('segments').put(segment);
  await txComplete(tx);
  return segment;
}

export async function getSegment(segmentId) {
  const db = await openDatabase();
  const tx = db.transaction('segments', 'readonly');
  const record = await requestToPromise(tx.objectStore('segments').get(segmentId));
  await txComplete(tx);
  return record || null;
}

export async function listSegmentsBySession(sessionId) {
  const db = await openDatabase();
  const tx = db.transaction('segments', 'readonly');
  const index = tx.objectStore('segments').index('sessionId');
  const segments = await requestToPromise(index.getAll(IDBKeyRange.only(sessionId)));
  await txComplete(tx);
  return segments.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
}

export async function countSegments(sessionId) {
  const db = await openDatabase();
  const tx = db.transaction('segments', 'readonly');
  const index = tx.objectStore('segments').index('sessionId');
  const count = await requestToPromise(index.count(IDBKeyRange.only(sessionId)));
  await txComplete(tx);
  return count;
}

export async function getStorageSummary() {
  const sessions = await listSessions();
  const db = await openDatabase();
  const tx = db.transaction('segments', 'readonly');
  const segmentCount = await requestToPromise(tx.objectStore('segments').count());
  await txComplete(tx);
  return {
    sessions: sessions.length,
    activeSessions: sessions.filter((session) => session.status !== 'ended').length,
    segments: segmentCount,
  };
}
