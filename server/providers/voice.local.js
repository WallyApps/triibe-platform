// LocalStubVoiceProvider — voice transcription. Today: rejects (we'll wire
// browser Web Speech API client-side until Whisper is enabled). The OpenAI
// Whisper provider replaces this with real audio -> text.
export class LocalStubVoiceProvider {
  constructor(db) { this.db = db; }
  async transcribe(/* audioBuffer */) {
    return { text: null, provider: 'local-stub',
             note: 'Voice transcription is disabled until OpenAI Whisper is wired. Type instead.' };
  }
}
