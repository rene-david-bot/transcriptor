const REALTIME_URL = 'https://api.openai.com/v1/realtime/calls';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const AUDIO_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_REALTIME_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
const REALTIME_WHISPER_MODEL = 'gpt-realtime-whisper';
const REALTIME_CALL_TIMEOUT_MS = 15000;
const DRAFT_TRANSLATION_MODEL = 'gpt-4o-mini';
const FINAL_TRANSLATION_MODEL = 'gpt-4.1-mini';
const SPEAKER_DIARIZATION_MODEL = 'gpt-4o-transcribe-diarize';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractErrorMessage(payload, fallback = 'OpenAI request failed') {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload;
  if (payload.error?.message) return payload.error.message;
  if (payload.message) return payload.message;
  return fallback;
}

function normalizeLanguageCode(code) {
  if (!code) return '';
  return String(code).trim().toLowerCase();
}

function normalizeRealtimeTranscriptionModel(model) {
  const nextModel = String(model || '').trim();
  if ([DEFAULT_REALTIME_TRANSCRIPTION_MODEL, REALTIME_WHISPER_MODEL].includes(nextModel)) {
    return nextModel;
  }
  return DEFAULT_REALTIME_TRANSCRIPTION_MODEL;
}

function buildRealtimeTurnDetectionConfig({ conservative = false } = {}) {
  return {
    type: 'server_vad',
    threshold: 0.5,
    prefix_padding_ms: conservative ? 300 : 180,
    silence_duration_ms: conservative ? 500 : 320,
  };
}

function buildRealtimeTranscriptionSessionConfig({
  transcriptionModel = DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
  sourceLanguage = '',
  sourceLanguageName = 'Source',
  targetLanguageName = 'Target',
  glossary = '',
  conservative = false,
} = {}) {
  const model = normalizeRealtimeTranscriptionModel(transcriptionModel);
  const normalizedLanguage = normalizeLanguageCode(sourceLanguage);
  const transcription = {
    model,
  };

  if (normalizedLanguage) {
    transcription.language = normalizedLanguage;
  }

  if (!conservative && model !== REALTIME_WHISPER_MODEL) {
    transcription.prompt = buildTranscriptionPrompt({
      sourceLanguageName,
      targetLanguageName,
      glossary,
    });
  }

  const input = {
    transcription,
    turn_detection: buildRealtimeTurnDetectionConfig({ conservative }),
  };

  if (!conservative) {
    input.noise_reduction = { type: 'near_field' };
  }

  return {
    type: 'transcription',
    audio: {
      input,
    },
  };
}

function parseMaybeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function shouldRetryRealtimeConnectionConservatively(error, model) {
  if (normalizeRealtimeTranscriptionModel(model) !== REALTIME_WHISPER_MODEL) {
    return false;
  }

  const status = Number(error?.status || 0);
  if (![0, 400, 404, 409, 422].includes(status)) {
    return false;
  }

  const message = String(error?.message || '').toLowerCase();
  return [
    'invalid',
    'unsupported',
    'unknown',
    'turn_detection',
    'noise_reduction',
    'prompt',
    'transcription',
    'session',
    'audio.input',
  ].some((token) => message.includes(token));
}

function shouldFallbackToDefaultRealtimeTranscription(error, model) {
  if (normalizeRealtimeTranscriptionModel(model) !== REALTIME_WHISPER_MODEL) {
    return false;
  }

  const status = Number(error?.status || 0);
  if ([0, 408, 500, 502, 503, 504, 520, 522, 524].includes(status)) {
    return true;
  }

  const message = String(error?.message || '').toLowerCase();
  return [
    'failed to fetch',
    'networkerror',
    'gateway time-out',
    'gateway timeout',
    'timed out',
    'timeout',
  ].some((token) => message.includes(token));
}

async function createRealtimeAnswerSdp({ apiKey, offerSdp, sessionConfig, timeoutMs = REALTIME_CALL_TIMEOUT_MS }) {
  const formData = new FormData();
  formData.set('sdp', offerSdp || '');
  formData.set('session', JSON.stringify(sessionConfig));

  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    response = await fetch(REALTIME_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`Realtime connection timed out after ${Math.round(timeoutMs / 1000)}s`);
      timeoutError.status = 408;
      timeoutError.cause = error;
      throw timeoutError;
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    const payload = parseMaybeJson(text);
    const error = new Error(extractErrorMessage(payload, text || `Realtime connection failed (${response.status})`));
    error.status = response.status;
    error.payload = payload;
    error.responseText = text;
    throw error;
  }

  return response.text();
}

export function buildRealtimeTranscriptionSessionPreview(options = {}) {
  return buildRealtimeTranscriptionSessionConfig(options);
}

function estimateMaxOutputTokens(text, draft = false) {
  const roughTokens = Math.ceil(String(text || '').length / 3);
  const floor = draft ? 48 : 96;
  const ceiling = draft ? 220 : 420;
  return Math.max(floor, Math.min(ceiling, roughTokens));
}

function buildTranscriptionPrompt({ sourceLanguageName, targetLanguageName, glossary }) {
  const glossaryLine = glossary?.trim()
    ? `Important glossary, names, products, companies, acronyms, or domain terms: ${glossary.trim()}`
    : 'No glossary was provided.';

  return [
    `Transcribe spoken ${sourceLanguageName} audio faithfully into ${sourceLanguageName} text.`,
    'Preserve names, companies, product names, numbers, dates, and technical vocabulary exactly when possible.',
    'Use sentence punctuation when it is clear from the audio, but do not summarize or rewrite.',
    glossaryLine,
    `A live translation into ${targetLanguageName} will happen separately, so keep the transcript faithful to the source speech.`,
  ].join(' ');
}

function extractResponseText(payload) {
  if (!payload) return '';
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  if (Array.isArray(payload.output)) {
    const parts = [];
    for (const item of payload.output) {
      if (!item?.content) continue;
      for (const content of item.content) {
        if (content?.type === 'output_text' && typeof content.text === 'string') {
          parts.push(content.text);
        }
      }
    }
    return parts.join('').trim();
  }

  return '';
}

export class RealtimeTranscriptionClient {
  constructor({
    apiKey,
    sourceLanguage,
    sourceLanguageName,
    targetLanguageName,
    glossary,
    transcriptionModel = DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
    microphoneDeviceId,
    echoCancellation = true,
    noiseSuppression = true,
    autoGainControl = true,
    onEvent,
    onStatus,
    onError,
    onStreamAvailable,
  }) {
    this.apiKey = apiKey;
    this.sourceLanguage = normalizeLanguageCode(sourceLanguage);
    this.sourceLanguageName = sourceLanguageName;
    this.targetLanguageName = targetLanguageName;
    this.glossary = glossary || '';
    this.transcriptionModel = normalizeRealtimeTranscriptionModel(transcriptionModel);
    this.microphoneDeviceId = String(microphoneDeviceId || '').trim();
    this.echoCancellation = echoCancellation !== false;
    this.noiseSuppression = noiseSuppression !== false;
    this.autoGainControl = autoGainControl !== false;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onError = onError;
    this.onStreamAvailable = onStreamAvailable;

    this.peerConnection = null;
    this.dataChannel = null;
    this.mediaStream = null;
    this.connectionId = null;
    this.rolloverTimer = null;
    this.disposed = false;
    this.reconnectAttempt = 0;
    this.lastManualCommitAt = 0;
    this.captureMuted = false;
  }

  async createAnswerSdpForModel({ offerSdp, transcriptionModel, conservative = false }) {
    return createRealtimeAnswerSdp({
      apiKey: this.apiKey,
      offerSdp,
      sessionConfig: buildRealtimeTranscriptionSessionConfig({
        transcriptionModel,
        sourceLanguage: this.sourceLanguage,
        sourceLanguageName: this.sourceLanguageName,
        targetLanguageName: this.targetLanguageName,
        glossary: this.glossary,
        conservative,
      }),
      timeoutMs: transcriptionModel === REALTIME_WHISPER_MODEL ? REALTIME_CALL_TIMEOUT_MS : REALTIME_CALL_TIMEOUT_MS,
    });
  }

  async fallbackToDefaultTranscriptionModel({ offerSdp, reason }) {
    this.onStatus?.('connecting', 'gpt-realtime-whisper timed out at OpenAI, retrying with the balanced default model...');
    this.onEvent?.({
      type: 'transcripto.realtime_model_fallback',
      fromModel: REALTIME_WHISPER_MODEL,
      toModel: DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
      reason: extractErrorMessage(reason, 'Realtime Whisper could not connect.'),
    });
    this.transcriptionModel = DEFAULT_REALTIME_TRANSCRIPTION_MODEL;
    return this.createAnswerSdpForModel({
      offerSdp,
      transcriptionModel: DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
      conservative: false,
    });
  }

  buildAudioConstraints({ includeDeviceId = true } = {}) {
    const constraints = {
      echoCancellation: this.echoCancellation,
      noiseSuppression: this.noiseSuppression,
      autoGainControl: this.autoGainControl,
    };

    if (includeDeviceId && this.microphoneDeviceId) {
      constraints.deviceId = { exact: this.microphoneDeviceId };
    }

    return constraints;
  }

  async requestMicrophoneStream() {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: this.buildAudioConstraints(),
      });
    } catch (error) {
      const missingSpecificMic =
        this.microphoneDeviceId && ['OverconstrainedError', 'NotFoundError'].includes(String(error?.name || ''));

      if (!missingSpecificMic) {
        throw error;
      }

      this.onStatus?.('connecting', 'Preferred microphone unavailable, falling back to the default microphone...');
      return navigator.mediaDevices.getUserMedia({
        audio: this.buildAudioConstraints({ includeDeviceId: false }),
      });
    }
  }

  async connect() {
    this.disposed = false;
    this.onStatus?.('connecting', 'Requesting microphone access and opening a live transcription connection...');

    try {
      this.mediaStream = await this.requestMicrophoneStream();

      if (this.onStreamAvailable) {
        try {
          this.onStreamAvailable(this.mediaStream.clone());
        } catch (error) {
          console.warn('Failed to provide a cloned stream for background analysis', error);
        }
      }

      this.peerConnection = new RTCPeerConnection();
      this.dataChannel = this.peerConnection.createDataChannel('oai-events');

      this.dataChannel.addEventListener('open', () => {
        this.reconnectAttempt = 0;
        this.onStatus?.('listening', 'Listening. Live transcription is active.');
      });

      this.dataChannel.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'session.created') {
            this.connectionId = payload.session?.id || payload.session_id || crypto.randomUUID();
          }
          if (payload.type === 'input_audio_buffer.committed') {
            this.lastManualCommitAt = 0;
          }
          if (payload.type === 'error') {
            const errorMessage = extractErrorMessage(payload, 'Realtime session error');
            if (this.shouldIgnoreRealtimeError(payload, errorMessage)) {
              console.debug('Ignoring expected realtime buffer error after manual commit', payload);
              this.lastManualCommitAt = 0;
              this.onEvent?.({
                type: 'transcripto.manual_commit.rejected',
                reason: 'buffer_too_small',
                message: errorMessage,
              });
              return;
            }
            this.onError?.(errorMessage);
            return;
          }
          this.onEvent?.(payload);
        } catch (error) {
          console.error('Failed to parse realtime event', error);
        }
      });

      this.dataChannel.addEventListener('close', () => {
        if (!this.disposed) {
          this.onStatus?.('stopped', 'Connection closed. You can resume the session.');
        }
      });

      this.peerConnection.addEventListener('connectionstatechange', () => {
        const state = this.peerConnection?.connectionState;
        if (!state) return;
        if (state === 'connecting') {
          this.onStatus?.('connecting', 'Connecting live audio transport...');
        } else if (state === 'connected') {
          this.onStatus?.('listening', 'Listening. Live transcription is active.');
        } else if (state === 'failed') {
          this.onError?.('Live connection failed. Try resuming the session.');
        } else if (state === 'disconnected') {
          this.onStatus?.('reconnecting', 'Connection interrupted. Trying to recover...');
        }
      });

      this.mediaStream.getTracks().forEach((track) => this.peerConnection.addTrack(track, this.mediaStream));

      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      let answerSdp;
      const requestedTranscriptionModel = this.transcriptionModel;
      try {
        answerSdp = await this.createAnswerSdpForModel({
          offerSdp: offer.sdp || '',
          transcriptionModel: requestedTranscriptionModel,
          conservative: false,
        });
      } catch (error) {
        if (shouldRetryRealtimeConnectionConservatively(error, requestedTranscriptionModel)) {
          this.onStatus?.('connecting', 'Retrying the experimental realtime model with a compatibility session setup...');
          try {
            answerSdp = await this.createAnswerSdpForModel({
              offerSdp: offer.sdp || '',
              transcriptionModel: requestedTranscriptionModel,
              conservative: true,
            });
          } catch (compatibilityError) {
            if (!shouldFallbackToDefaultRealtimeTranscription(compatibilityError, requestedTranscriptionModel)) {
              throw compatibilityError;
            }
            answerSdp = await this.fallbackToDefaultTranscriptionModel({
              offerSdp: offer.sdp || '',
              reason: compatibilityError,
            });
          }
        } else if (shouldFallbackToDefaultRealtimeTranscription(error, requestedTranscriptionModel)) {
          answerSdp = await this.fallbackToDefaultTranscriptionModel({
            offerSdp: offer.sdp || '',
            reason: error,
          });
        } else {
          throw error;
        }
      }

      await this.peerConnection.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      this.scheduleRollover();
      return { connectionId: this.connectionId };
    } catch (error) {
      await this.disconnect({ nextStatus: 'error', message: extractErrorMessage(error, 'Unable to start live transcription') });
      throw error;
    }
  }

  scheduleRollover() {
    window.clearTimeout(this.rolloverTimer);
    this.rolloverTimer = window.setTimeout(() => {
      if (!this.disposed) {
        this.onEvent?.({ type: 'transcripto.rollover.requested' });
      }
    }, 55 * 60 * 1000);
  }

  sendEvent(payload) {
    if (!payload || !this.dataChannel || this.dataChannel.readyState !== 'open') {
      return false;
    }

    try {
      this.dataChannel.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      console.warn('Failed to send realtime event', error);
      return false;
    }
  }

  commitInputAudioBuffer() {
    this.lastManualCommitAt = Date.now();
    return this.sendEvent({
      type: 'input_audio_buffer.commit',
      event_id: crypto.randomUUID(),
    });
  }

  setCaptureMuted(muted = false) {
    this.captureMuted = Boolean(muted);
    const tracks = this.mediaStream?.getAudioTracks?.() || [];
    tracks.forEach((track) => {
      track.enabled = !this.captureMuted;
    });
    return tracks.length > 0;
  }

  shouldIgnoreRealtimeError(payload, message = '') {
    const errorMessage = String(message || '').toLowerCase();
    const errorParam = String(payload?.error?.param || '').toLowerCase();
    const audioBufferError = errorParam.includes('input_audio_buffer') || errorMessage.includes('audio buffer');
    const benignBufferRejection =
      errorMessage.includes('empty') ||
      errorMessage.includes('too small') ||
      errorMessage.includes('expected at least 100ms');

    return Boolean(audioBufferError && benignBufferRejection);
  }

  async disconnect({ nextStatus = 'stopped', message = 'Stopped.' } = {}) {
    this.disposed = true;
    this.lastManualCommitAt = 0;
    window.clearTimeout(this.rolloverTimer);
    this.rolloverTimer = null;

    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {
        // ignore
      }
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      try {
        this.peerConnection.getSenders().forEach((sender) => sender.track?.stop());
        this.peerConnection.close();
      } catch {
        // ignore
      }
      this.peerConnection = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.onStatus?.(nextStatus, message);
    await sleep(0);
  }
}

export async function runFinalSessionAnalysis({ apiKey, audioBlob, filename, language, signal }) {
  const formData = new FormData();
  formData.set('file', audioBlob, filename || 'session-analysis.wav');
  formData.set('model', SPEAKER_DIARIZATION_MODEL);
  formData.set('response_format', 'diarized_json');
  formData.set('chunking_strategy', 'auto');
  formData.set('temperature', '0');
  if (language) {
    formData.set('language', normalizeLanguageCode(language));
  }

  const response = await fetch(AUDIO_TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
    body: formData,
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(extractErrorMessage(json, `Session analysis failed (${response.status})`));
  }

  const segments = Array.isArray(json?.segments) ? json.segments : [];
  const rawSpeakerTurns = Array.isArray(json?.speaker_turns) && json.speaker_turns.length ? json.speaker_turns : segments;
  const words = Array.isArray(json?.words)
    ? json.words
    : rawSpeakerTurns.flatMap((segment) => (Array.isArray(segment?.words) ? segment.words : []));

  const speakerTurns = rawSpeakerTurns
    .map((segment, index) => ({
      id: String(segment?.id || `turn-${index + 1}`),
      speaker: String(segment?.speaker || segment?.label || '').trim(),
      rawSpeaker: String(segment?.rawSpeaker || segment?.speaker || '').trim(),
      label: String(segment?.label || '').trim(),
      text: String(segment?.text || '').trim(),
      start: Number(segment?.start || 0),
      end: Number(segment?.end || 0),
    }))
    .filter((segment) => segment.end > segment.start);

  return {
    durationSeconds: Number(json?.duration || 0),
    text: String(json?.text || ''),
    words,
    speakerTurns,
    segments,
    raw: json,
  };
}

export async function diarizeAudioChunk(options) {
  return runFinalSessionAnalysis(options);
}

export async function translateText({
  apiKey,
  sourceLanguageName,
  targetLanguageName,
  glossary,
  sourceText,
  draft = false,
  model,
  signal,
}) {
  const instructions = [
    `You translate live speech from ${sourceLanguageName} into ${targetLanguageName}.`,
    'Translate faithfully. Do not summarize, explain, add commentary, or clean up beyond what is necessary for readability.',
    'Preserve names, companies, product names, acronyms, numbers, dates, and technical terms exactly when possible.',
    draft
      ? 'The input may be incomplete mid-sentence. Produce the best partial translation so far without adding ellipses unless the source clearly implies them.'
      : 'The input is a completed speech segment. Return the final translation only.',
    glossary?.trim() ? `Preferred glossary/context: ${glossary.trim()}` : 'No glossary was provided.',
  ].join(' ');

  const payload = {
    model: model || (draft ? DRAFT_TRANSLATION_MODEL : FINAL_TRANSLATION_MODEL),
    instructions,
    store: false,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: sourceText }],
      },
    ],
    max_output_tokens: estimateMaxOutputTokens(sourceText, draft),
    text: {
      format: { type: 'text' },
    },
  };

  const response = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal,
    body: JSON.stringify(payload),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(extractErrorMessage(json, `Translation failed (${response.status})`));
  }

  return extractResponseText(json);
}
