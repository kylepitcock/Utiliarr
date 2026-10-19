export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface RequestOpts {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

export class HttpClient {
  constructor(
    private name: string,
    private baseUrl: () => string,
    private headers: () => Record<string, string>,
  ) {}

  get configured() {
    return !!this.baseUrl();
  }

  async request<T = any>(path: string, opts: RequestOpts = {}): Promise<T> {
    const base = this.baseUrl().replace(/\/+$/, '');
    if (!base) throw new Error(`${this.name} is not configured`);
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...this.headers() },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
      });
    } catch (e) {
      throw new Error(`${this.name} unreachable: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, `${this.name} ${opts.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }
}
