const { withNativeFederation, shareAll, share } = require('@angular-architects/native-federation/config');

module.exports = withNativeFederation({
  name: 'voice',

  exposes: {
    './VoiceStudioPrefab': './src/app/prefabs/voice-studio/exposed.ts',
    './VoiceMicButtonPrefab': './src/app/prefabs/voice-mic-button/exposed.ts',
    './VoiceSpeakerPrefab': './src/app/prefabs/voice-speaker/exposed.ts',
    './VoiceSettingsPrefab': './src/app/prefabs/voice-settings/exposed.ts',
    './VoiceDictaphonePrefab': './src/app/prefabs/voice-dictaphone/exposed.ts',
  },

  shared: {
    ...shareAll({ singleton: true, strictVersion: true, requiredVersion: 'auto' }),
    ...share({ '@loynazkovacs/theitemapp-platform-sdk': { singleton: true, strictVersion: true, requiredVersion: 'auto' } }),
  },

  skip: [
    'rxjs/ajax',
    'rxjs/fetch',
    'rxjs/testing',
    'rxjs/webSocket',
  ],

  features: {
    ignoreUnusedDeps: true,
  },
});
