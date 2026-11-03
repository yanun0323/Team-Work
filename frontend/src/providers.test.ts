import { describe, expect, it } from 'vitest'
import { addProvider, deleteProvider, providerUsers, updateProvider } from './core/domain/sim'
import { seedWorld } from './core/data/seed'
import { modelGroups, modelsOf } from './crew'
import { authLabel, providerUrl } from './providers'

describe('model providers', () => {
  it('keeps only the end of the key, and offers the new models to employees', () => {
    const w = seedWorld()
    const p = addProvider(w, { name: ' Local ', kind: 'compatible', baseUrl: ' http://localhost:11434/v1 ', login: { kind: 'apiKey', apiKey: 'sk-secret-1234' }, models: ['qwen3', 'qwen3'] })
    expect(p).toMatchObject({ name: 'Local', baseUrl: 'http://localhost:11434/v1', auth: { kind: 'apiKey', keyHint: '1234' }, models: ['qwen3'] })
    expect(JSON.stringify(w.providers)).not.toContain('secret')
    expect(modelsOf(w)).toContain('qwen3')
  })

  it('signs in to a subscription without a key or address', () => {
    const w = seedWorld()
    const p = addProvider(w, { name: 'ChatGPT 訂閱', kind: 'openai', baseUrl: 'https://x', login: { kind: 'subscription' }, models: ['gpt-5.5'] })
    expect(p.auth).toEqual({ kind: 'subscription', signedIn: true })
    expect(p.baseUrl).toBe('')
    expect(authLabel(p)).toBe('ChatGPT 訂閱')
  })

  it('edits the name and address, keeping the key unless a new one is given', () => {
    const w = seedWorld()
    updateProvider(w, 'mp-deepseek', { name: ' DS ', baseUrl: 'https://ds/v1', login: { kind: 'apiKey', apiKey: '' } })
    expect(w.providers['mp-deepseek']).toMatchObject({ name: 'DS', baseUrl: 'https://ds/v1', auth: { kind: 'apiKey', keyHint: '0f4e' } })
    updateProvider(w, 'mp-deepseek', { name: 'DS', baseUrl: 'https://ds/v1', login: { kind: 'apiKey', apiKey: 'sk-new-9z9z' } })
    expect(w.providers['mp-deepseek'].auth).toEqual({ kind: 'apiKey', keyHint: '9z9z' })
    updateProvider(w, 'mp-openai', { name: 'OpenAI', baseUrl: 'https://x', login: { kind: 'subscription' } })
    expect(w.providers['mp-openai']).toMatchObject({ auth: { kind: 'subscription' }, baseUrl: '' })
  })

  it('refuses to delete a provider someone runs on', () => {
    const w = seedWorld()
    expect(providerUsers(w, 'mp-anthropic').length).toBeGreaterThan(0)
    expect(deleteProvider(w, 'mp-anthropic')).toBe(false)
    expect(w.providers['mp-anthropic']).toBeDefined()
    expect(providerUsers(w, 'mp-deepseek')).toEqual([])
    expect(deleteProvider(w, 'mp-deepseek')).toBe(true)
    expect(w.providers['mp-deepseek']).toBeUndefined()
  })

  it('uses the kind’s own address when none is given', () => {
    expect(providerUrl({ kind: 'openai', baseUrl: '' })).toBe('https://api.openai.com/v1')
    expect(providerUrl({ kind: 'openai', baseUrl: 'https://proxy/v1' })).toBe('https://proxy/v1')
  })
})

describe('modelGroups', () => {
  it('lists each model once, under the first provider offering it, and the orphaned ones last', () => {
    const w = seedWorld()
    w.providers = {
      a: { ...Object.values(w.providers)[0], id: 'a', name: 'First', models: ['m1', 'shared'] },
      b: { ...Object.values(w.providers)[0], id: 'b', name: 'Second', models: ['shared', 'm2'] },
      c: { ...Object.values(w.providers)[0], id: 'c', name: 'Empty', models: [] },
    }
    w.replicas = { r: { ...Object.values(w.replicas)[0], model: 'gone' } }
    expect(modelGroups(w)).toEqual([
      { label: 'First', models: ['m1', 'shared'] },
      { label: 'Second', models: ['m2'] },
      { label: '其他', models: ['gone'] },
    ])
    expect(modelsOf(w)).toEqual(['m1', 'shared', 'm2', 'gone'])
  })
})
