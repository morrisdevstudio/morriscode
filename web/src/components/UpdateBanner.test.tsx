// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UpdateBanner } from './UpdateBanner'

beforeEach(() => {
  localStorage.clear()
})

describe('UpdateBanner', () => {
  it('renders null when update_pending is not set', () => {
    const html = renderToStaticMarkup(<UpdateBanner />)
    expect(html).toBe('')
  })

  it('uses fixed positioning and correct z-index when rendered', () => {
    localStorage.setItem('update_pending', 'true')
    localStorage.setItem('morriscode_updated_to', '99.0.0')
    const html = renderToStaticMarkup(<UpdateBanner />)
    expect(html).toContain('fixed')
    expect(html).toContain('z-[100]')
    expect(html).toContain('bottom-20')
  })
})
