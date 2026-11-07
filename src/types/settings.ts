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

export interface ImageModelInfo {
  id: string;
  label: string;
  blurb: string;
}

/** OpenAI image models offered in Settings (GPT image models always return base64 images). */
export const IMAGE_MODELS: readonly ImageModelInfo[] = [
  { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare', blurb: 'Fast everyday illustrations. Recommended.' },
  { id: 'gpt-image-2.6-flare', label: 'GPT Image 2.6 Flare', blurb: 'Newest fast model.' },
  { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst', blurb: 'Slower, more precise detail.' },
  { id: 'gpt-image-2.6-sunburst', label: 'GPT Image 2.6 Sunburst', blurb: 'Newest precise model.' },
  { id: 'gpt-image-1-mini', label: 'GPT Image 1 Mini', blurb: 'Cheapest, simpler images.' },
];

export type ImageFrequency = 'off' | 'request' | 'moments';

export interface ImageSettings {
  /** OpenAI API key (platform.openai.com). Stored only in this browser, like the Anthropic key. */
  openaiApiKey: string;
  model: string;
  quality: 'low' | 'medium' | 'high';
  /** off = never; request = only when the player asks; moments = the DM may illustrate key moments. */
  frequency: ImageFrequency;
}

export const DEFAULT_IMAGE_SETTINGS: ImageSettings = {
  openaiApiKey: '',
  model: 'gpt-image-2.5-flare',
  quality: 'medium',
  frequency: 'request',
};

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
  images: ImageSettings;
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
  images: DEFAULT_IMAGE_SETTINGS,
};

/** An illustration stored in IndexedDB (never in exports or GitHub saves: too large). */
export interface StoredImage {
  id: string;
  campaignId: string;
  sessionId: string | null;
  title: string;
  subject: import('./game').ImageSubject;
  /** The full prompt sent to the image model. */
  prompt: string;
  model: string;
  mime: string;
  blob: Blob;
  createdAt: number;
}

/** One message of a session's Anthropic API transcript, stored verbatim (append-only). */
export interface TranscriptMessage {
  id: string;
  sessionId: string;
  /** Monotonic per session; defines order. */
  seq: number;
  param: BetaMessageParam;
  createdAt: number;
}
