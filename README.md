# Transcripto

Transcripto is a clean, mobile-friendly Progressive Web App for **live speech transcription + translation** during keynotes, rehearsals, meetings, and other spoken events.

It listens through the browser microphone, keeps a **source-language transcript**, translates each finalized segment into a **target language**, and stores sessions locally so they can be reopened or exported later.

## Live site

GitHub Pages: https://rene-david-bot.github.io/transcriptor/

## What this build does

- installable PWA for Android Chrome, iOS Safari, and desktop browsers
- local-only OpenAI API key entry with edit + forget controls
- source language default: **Italian**
- target language default: **English**
- optional glossary/context for names, products, companies, acronyms, and technical terms
- optional speaker-name seeding for cleaner live labels
- live session page with:
  - start / pause / resume / stop
  - end session
  - status indicator
- current live source draft
- current live translation draft
- best-effort background speaker attribution + timing
- total speaker time summary that remains visible after stop / end
- per-speaker rename controls for cleaner labels in the session and exports
- scrolling bilingual transcript
- local session history with reopen, rename, export, and delete
- export as **Markdown**, **TXT**, and **JSON**
- local recovery / resume of the last active session
- silent long-session rollover to refresh the live connection

## Architecture

This is a **static GitHub Pages app**.

Because there is no server runtime in GitHub Pages, the current build uses a **direct browser-to-OpenAI** flow with a user-provided key stored locally in the browser.

### OpenAI API path used

- **Realtime transcription**: OpenAI Realtime API over WebRTC
  - session type: `transcription`
  - transcription model: `gpt-4o-mini-transcribe`
- **Translation**: OpenAI Responses API
  - draft translation model: `gpt-4o-mini`
  - final translation model: `gpt-4.1-mini`
- **Speaker diarization**: OpenAI Audio Transcriptions API
  - diarization model: `gpt-4o-transcribe-diarize`

### Why this split

- Realtime transcription gives low-latency live text from microphone input.
- Draft translation is tuned for speed during speech, while finalized translation stays higher quality.
- Speaker diarization runs as a separate best-effort background path so live text remains the priority.
- This also makes local session storage and export simpler than an all-in-one speech-to-speech flow.

## API key handling

- no key is committed to the repository
- no key is server-stored
- the user pastes a key into the app
- the key is stored only in this browser unless removed
- **Forget API key** removes it from local browser storage

Important: because this is a client-side key flow, use a key you personally control.

## Session behavior

- **Pause** stops microphone sending and closes the live connection to avoid extra cost
- **Resume** continues the same logical session and transcript
- **Stop** disconnects the live session without ending the transcript
- **End Session** marks the session finished and keeps it in local history
- transcript segments are saved locally after each finalized segment
- if the app is refreshed or reopened, the last active session can be resumed
- the app rolls the live connection after about **55 minutes** to keep long sessions healthy

## Local development

Because this is a static app, you can preview it with any local static server.

Example:

```bash
cd transcriptor
python3 -m http.server 4173
```

Then open:

```text
http://localhost:4173
```

## Deploying to GitHub Pages

This repository includes a GitHub Actions workflow that deploys on every push to `main`.

### Expected Pages URL

```text
https://rene-david-bot.github.io/transcriptor/
```

### Deployment steps

1. Push the repository to GitHub.
2. In GitHub repository settings, ensure **Pages** is set to **GitHub Actions**.
3. The included workflow publishes the static app automatically.

## Data model

Core session objects are stored locally in IndexedDB.

### Session

```json
{
  "id": "string",
  "title": "string",
  "status": "active | paused | ended",
  "runtimeStatus": "idle | connecting | listening | paused | reconnecting | stopped | ended | error",
  "sourceLanguage": "it",
  "targetLanguage": "en",
  "glossary": "optional string",
  "speakerNames": "Rene, Moderator",
  "speakerAliases": {
    "A": "Rene"
  },
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp",
  "endedAt": "ISO timestamp",
  "activeDurationMs": 0,
  "speechOnlyMs": 0,
  "segmentCount": 0
}
```

### Transcript segment

```json
{
  "id": "string",
  "sessionId": "string",
  "realtimeConnectionId": "string",
  "startMs": 0,
  "endMs": 0,
  "speechEndMs": 0,
  "sourceLanguage": "it",
  "targetLanguage": "en",
  "sourceText": "string",
  "translatedText": "string",
  "speakerRawLabel": "A",
  "speakerLabel": "Rene",
  "speakerDurationMs": 15000,
  "speakerStatus": "pending | done | unsupported",
  "createdAt": "ISO timestamp"
}
```

## Limitations

- This is a **personal tool**, not a public multi-user SaaS product.
- Because the app is static, it currently relies on a **client-side OpenAI key**.
- Browser microphone + WebRTC behavior can vary slightly across browsers, especially on iOS.
- Live draft translation is optimized for speed, but still best-effort rather than word-by-word streaming.
- Speaker attribution/timing is lower-priority background analysis and may lag by roughly 20 to 40 seconds.
- Speaker names are a UI mapping layer unless you later add separate voice-reference support.
- If OpenAI or the browser interrupts a long live session, the app keeps the saved transcript and lets the user resume.

## Next obvious upgrade path

If this ever moves beyond personal use, the next step should be a **minimal server-side ephemeral token / proxy layer** so standard OpenAI keys never touch the browser directly.
