/**
 * Shared catalog of languages offered for speech-to-text (dictation).
 *
 * `code` is the ISO 639-1 code forwarded to the OmniVoice `/transcribe`
 * `language` form field (faster-whisper accepts these directly). An empty
 * code means "auto-detect" — let the recognizer guess the spoken language.
 *
 * faster-whisper supports ~100 languages; we expose a curated short list so
 * the picker stays usable. Keep this in sync with the `user_ui_configs.voice.
 * sttLanguage` preference and the voice-settings / dictaphone selectors.
 */
export interface VoiceLanguageOption {
  readonly code: string;
  readonly label: string;
}

export const STT_LANGUAGE_OPTIONS: ReadonlyArray<VoiceLanguageOption> = [
  { code: '',   label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'hu', label: 'Magyar' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'ro', label: 'Română' },
  { code: 'sk', label: 'Slovenčina' },
  { code: 'cs', label: 'Čeština' },
  { code: 'ru', label: 'Русский' },
  { code: 'uk', label: 'Українська' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
];
