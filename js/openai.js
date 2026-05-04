const REALTIME_URL = 'https://api.openai.com/v1/realtime/calls';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';

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
  constructor({ apiKey, sourceLanguage, sourceLanguageName, targetLanguageName, glossary, onEvent, onStatus, onError }) {
    this.apiKey = apiKey;
    this.sourceLanguage = normalizeLanguageCode(sourceLanguage);
    this.sourceLanguageName = sourceLanguageName;
    this.targetLanguageName = targetLanguageName;
    this.glossary = glossary || '';
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onError = onError;

    this.peerConnection = null;
    this.dataChannel = null;
    this.mediaStream = null;
    this.connectionId = null;
    this.rolloverTimer = null;
    this.disposed = false;
    this.reconnectAttempt = 0;
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
          if (payload.type === 'error') {
            this.onError?.(extractErrorMessage(payload, 'Realtime session error'));
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
              model: 'gpt-4o-transcribe',
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
              prefix_padding_ms: 250,
              silence_duration_ms: 650,
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
        this.onEvent?.({ type: 'transcriptor.rollover.requested' });
      }
    }, 55 * 60 * 1000);
  }

  async disconnect({ nextStatus = 'stopped', message = 'Stopped.' } = {}) {
    this.disposed = true;
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

export async function translateText({ apiKey, sourceLanguageName, targetLanguageName, glossary, sourceText, draft = false }) {
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
    model: 'gpt-4.1-mini',
    instructions,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: sourceText }],
      },
    ],
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
    body: JSON.stringify(payload),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(extractErrorMessage(json, `Translation failed (${response.status})`));
  }

  return extractResponseText(json);
}
