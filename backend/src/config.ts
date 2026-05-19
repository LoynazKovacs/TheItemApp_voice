export interface AppConfig {
  port: number;
  coreApiUrl: string;
  coreApiKey: string | null;
  omnivoiceBaseUrl: string;
  upstreamTimeoutMs: number;
  defaultVoice: string;
  defaultModel: string;
  appKey: string;
  appRegistrationKey: string | null;
  registrationBaseUrl: string;
  registrationHeartbeatMs: number;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTimeoutMs(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getConfig(): AppConfig {
  const port = parsePort(process.env.VOICE_API_PORT, 3005);
  const appKey = (process.env.VOICE_APP_KEY ?? '').trim() || 'voice';

  return {
    port,
    coreApiUrl: (process.env.CORE_API_URL ?? '').trim() || 'http://backend:3001',
    coreApiKey: (process.env.VOICE_CORE_API_KEY ?? '').trim() || null,
    omnivoiceBaseUrl: (process.env.OMNIVOICE_BASE_URL ?? '').trim() || 'http://omnivoice:3900',
    upstreamTimeoutMs: parseTimeoutMs(process.env.VOICE_UPSTREAM_TIMEOUT_MS, 120_000),
    defaultVoice: (process.env.VOICE_DEFAULT_VOICE ?? '').trim() || 'demo0001',
    defaultModel: (process.env.VOICE_DEFAULT_MODEL ?? '').trim() || 'omnivoice',
    appKey,
    appRegistrationKey: (process.env.APP_REGISTRATION_KEY ?? '').trim() || null,
    registrationBaseUrl: (process.env.VOICE_REGISTRATION_BASE_URL ?? '').trim() || `http://voice-api:${port}`,
    registrationHeartbeatMs: parseTimeoutMs(process.env.VOICE_REGISTRATION_HEARTBEAT_MS, 5 * 60 * 1000),
  };
}
