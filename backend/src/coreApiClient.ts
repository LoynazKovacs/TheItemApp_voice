export class CoreApiError extends Error {
  public readonly status: number;
  public readonly method: string;
  public readonly url: string;
  public readonly body: string;

  constructor(method: string, url: string, status: number, body: string) {
    super(`[coreApi] ${method} ${url} failed: ${status} — ${body}`);
    this.name = 'CoreApiError';
    this.method = method;
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

export type CoreApiConfig = {
  baseUrl: string;
  apiKey: string | null;
};

export class CoreApiClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: CoreApiConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
      'x-theitemapp-skip-webhooks': '1',
    };
  }

  updateApiKey(apiKey: string): void {
    this.headers['x-api-key'] = apiKey;
  }

  async verifyAuth(authorization?: string, cookie?: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/auth/profile`, {
        method: 'GET',
        headers: this.requestHeaders(authorization, cookie),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private requestHeaders(authorization?: string, cookie?: string): Record<string, string> {
    const header = typeof authorization === 'string' && authorization.trim().length > 0 ? authorization.trim() : '';
    const cookieHeader = typeof cookie === 'string' && cookie.trim().length > 0 ? cookie.trim() : '';
    return {
      ...this.headers,
      ...(header ? { Authorization: header } : {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    };
  }
}
