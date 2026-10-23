import { describe, expect, it } from 'vitest'
import { AutoUpdateModal } from './AutoUpdateModal'

describe('AutoUpdateModal compatibility export', () => {
  it('re-exports the update dialog', () => {
    expect(typeof AutoUpdateModal).toBe('function')
  })
})
