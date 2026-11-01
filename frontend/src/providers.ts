// The kinds of model provider, as the settings name them, and what a new one of each starts with.

import { tr } from './core/i18n'
import type { ModelProvider, ProviderKind } from './core/domain/types'

export const PROVIDER_KINDS: Record<ProviderKind, { label: string; url: string; models: string[] }> = {
  anthropic: { label: 'Anthropic', url: 'https://api.anthropic.com', models: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-5'] },
  openai: { label: 'OpenAI', url: 'https://api.openai.com/v1', models: ['gpt-5.5', 'gpt-5.5-codex'] },
  google: { label: 'Google Gemini', url: 'https://generativelanguage.googleapis.com', models: ['gemini-3-pro'] },
  // anything that speaks the OpenAI API: a local server, a gateway, another vendor
  compatible: { get label() { return tr('OpenAI 相容') }, url: '', models: [] },
}

/** Made-up levels for the mock providers, which a real provider reports itself. */
const MOCK_LEVELS: Record<ProviderKind, string[]> = {
  anthropic: ['low', 'medium', 'high', 'xhigh', 'max'],
  openai: ['low', 'medium', 'high', 'xhigh'],
  google: ['low', 'high'],
  compatible: ['low', 'high', 'max'],
}

export const mockThinking = (kind: ProviderKind, models: string[]) =>
  Object.fromEntries(models.map((m) => [m, MOCK_LEVELS[kind]]))

/** The address a provider is reached at: its own, or the kind's usual one. */
export const providerUrl = (p: Pick<ModelProvider, 'kind' | 'baseUrl'>) => p.baseUrl || PROVIDER_KINDS[p.kind].url

/** The subscription each kind can be signed in to instead of a key, if any. */
export const SUBSCRIPTIONS: Partial<Record<ProviderKind, string>> = { anthropic: 'Claude', openai: 'ChatGPT' }

/** How a provider is signed in to, in words. */
export const authLabel = (p: Pick<ModelProvider, 'kind' | 'auth'>) =>
  p.auth.kind === 'subscription' ? tr('{a} 訂閱', { a: SUBSCRIPTIONS[p.kind] ?? '' }) : 'API Key'
