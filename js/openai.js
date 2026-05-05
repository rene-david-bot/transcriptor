const REALTIME_URL = 'https://api.openai.com/v1/realtime/calls';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const AUDIO_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
const REALTIME_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
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
  constructor({ apiKey, sourceLanguage, sourceLanguageName, targetLanguageName, glossary, onEvent, onStatus, onError, onStreamAvailable }) {
    this.apiKey = apiKey;
    this.sourceLanguage = normalizeLanguageCode(sourceLanguage);
    this.sourceLanguageName = sourceLanguageName;
    this.targetLanguageName = targetLanguageName;
    this.glossary = glossary || '';
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
  }

  async connect() {
    this.disposed = false;
    this.onStatus?.('connecting', 'Requesting microphone access and opening a live transcription connection...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

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

      const sessionConfig = {
        type: 'transcription',
        audio: {
          input: {
            transcription: {
              model: REALTIME_TRANSCRIPTION_MODEL,
              language: this.sourceLanguage,
              prompt: buildTranscriptionPrompt({
                sourceLanguageName: this.sourceLanguageName,
                targetLanguageName: this.targetLanguageName,
                glossary: this.glossary,
              }),
            },
            noise_reduction: { type: 'near_field' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 180,
              silence_duration_ms: 320,
              create_response: false,
            },
          },
        },
      };

      const formData = new FormData();
      formData.set('sdp', offer.sdp || '');
      formData.set('session', JSON.stringify(sessionConfig));

      const response = await fetch(REALTIME_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Realtime connection failed (${response.status})`);
      }

      const answerSdp = await response.text();
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

  shouldIgnoreRealtimeError(payload, message = '') {
    const errorMessage = String(message || '').toLowerCase();
    const errorParam = String(payload?.error?.param || '').toLowerCase();
    const justCommitted = this.lastManualCommitAt && Date.now() - this.lastManualCommitAt < 3000;

    return Boolean(
      justCommitted &&
        (errorParam.includes('input_audio_buffer') || errorMessage.includes('audio buffer')) &&
        errorMessage.includes('empty')
    );
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

export async function diarizeAudioChunk({ apiKey, audioBlob, filename, language, signal }) {
  const formData = new FormData();
  formData.set('file', audioBlob, filename || 'speaker-chunk.webm');
  formData.set('model', SPEAKER_DIARIZATION_MODEL);
  formData.set('response_format', 'diarized_json');
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
    throw new Error(extractErrorMessage(json, `Speaker diarization failed (${response.status})`));
  }

  return {
    durationSeconds: Number(json?.duration || 0),
    text: String(json?.text || ''),
    segments: Array.isArray(json?.segments) ? json.segments : [],
  };
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
