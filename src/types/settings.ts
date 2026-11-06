/**
 * App-wide settings (stored only in this browser) and the API transcript record.
 */
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';

export type ModelId = 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5' | (string & {});

export interface ModelInfo {
  id: ModelId;
  label: string;
  blurb: string;
  /** USD per million tokens. */
  pricing: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };
  /** Whether server-side refusal fallbacks (`fallbacks: "default"`) are supported. */
  supportsFallbacks: boolean;
}

export const MODELS: readonly ModelInfo[] = [
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    blurb: 'Most capable. Richest storytelling and the best rules judgment.',
    pricing: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
    supportsFallbacks: true,
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    blurb: 'Fast and capable at half the price of Opus.',
    pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
    supportsFallbacks: true,
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    blurb: 'Cheapest and quickest. Good for light, casual play.',
    pricing: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
    supportsFallbacks: false,
  },
];

export const DEFAULT_MODEL: ModelId = 'claude-opus-5-5';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** omitted = hidden; updates = short progress notes between tool calls; summarized = reasoning summaries (may spoil secrets). */
export type ThinkingDisplay = 'omitted' | 'updates' | 'summarized';

export interface GithubSyncSettings {
  enabled: boolean;
  /** Fine-grained personal access token with Contents read/write on ONE private repo. */
  token: string;
  owner: string;
  repo: string;
  branch: string;
  /** Folder inside the repo, e.g. "saves". */
  path: string;
  lastSyncedAt: number | null;
}

export interface AppSettings {
  /** Anthropic API key. Stored only in this browser. */
  apiKey: string;
  /** Remember the key across browser restarts (localStorage) or only for this tab (sessionStorage). */
  rememberApiKey: boolean;
  model: ModelId;
  effort: Effort;
  thinkingDisplay: ThinkingDisplay;
  maxTokens: number;
  /** Opt into server-side refusal fallbacks on models that support them. */
  useFallbacks: boolean;
  cacheTtl: '5m' | '1h';
  /** Suggest wrapping up the session once the context passes this many tokens. */
  sessionSoftLimitTokens: number;
  theme: 'system' | 'dark' | 'light';
  narrationFont: 'serif' | 'sans';
  textSize: 'sm' | 'md' | 'lg';
  diceAnimations: boolean;
  /** Offline demo DM that makes no API calls (for trying the app without a key). */
  mockMode: boolean;
  githubSync: GithubSyncSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  rememberApiKey: true,
  model: DEFAULT_MODEL,
  effort: 'medium',
  thinkingDisplay: 'omitted',
  maxTokens: 32000,
  useFallbacks: true,
  cacheTtl: '1h',
  sessionSoftLimitTokens: 150_000,
  theme: 'system',
  narrationFont: 'serif',
  textSize: 'md',
  diceAnimations: true,
  mockMode: false,
  githubSync: {
    enabled: false,
    token: '',
    owner: '',
    repo: '',
    branch: 'main',
    path: 'saves',
    lastSyncedAt: null,
  },
};

/** One message of a session's Anthropic API transcript, stored verbatim (append-only). */
export interface TranscriptMessage {
  id: string;
  sessionId: string;
  /** Monotonic per session; defines order. */
  seq: number;
  param: BetaMessageParam;
  createdAt: number;
}
