import { describe, expect, it, afterEach } from 'vitest'
import { getMcpOAuthRedirectUri, setMcpOAuthServerPort } from './oauth-provider.js'

const ORIGINAL_PUBLIC_URL = process.env['MORRISCODE_PUBLIC_URL']

describe('getMcpOAuthRedirectUri', () => {
  afterEach(() => {
    if (ORIGINAL_PUBLIC_URL === undefined) delete process.env['MORRISCODE_PUBLIC_URL']
    else process.env['MORRISCODE_PUBLIC_URL'] = ORIGINAL_PUBLIC_URL
    setMcpOAuthServerPort(10369)
  })

  it('defaults to a loopback URL on the current server port when MORRISCODE_PUBLIC_URL is unset', () => {
    delete process.env['MORRISCODE_PUBLIC_URL']
    setMcpOAuthServerPort(54321)

    expect(getMcpOAuthRedirectUri()).toBe('http://127.0.0.1:54321/api/mcp/oauth/callback')
  })

  it('uses MORRISCODE_PUBLIC_URL as the origin when set', () => {
    process.env['MORRISCODE_PUBLIC_URL'] = 'https://morriscode.example.com'

    expect(getMcpOAuthRedirectUri()).toBe('https://morriscode.example.com/api/mcp/oauth/callback')
  })

  it('keeps the prefix when MORRISCODE_PUBLIC_URL points at a sub-path deployment', () => {
    process.env['MORRISCODE_PUBLIC_URL'] = 'https://tunnel.example.com/morriscode'

    expect(getMcpOAuthRedirectUri()).toBe('https://tunnel.example.com/morriscode/api/mcp/oauth/callback')
  })

  it('does not double the separator when MORRISCODE_PUBLIC_URL ends with a slash', () => {
    process.env['MORRISCODE_PUBLIC_URL'] = 'https://tunnel.example.com/morriscode/'

    expect(getMcpOAuthRedirectUri()).toBe('https://tunnel.example.com/morriscode/api/mcp/oauth/callback')
  })

  it('drops a query string and a fragment carried by MORRISCODE_PUBLIC_URL', () => {
    process.env['MORRISCODE_PUBLIC_URL'] = 'https://morriscode.example.com/?next=x#frag'

    expect(getMcpOAuthRedirectUri()).toBe('https://morriscode.example.com/api/mcp/oauth/callback')
  })

  it('rejects a non http URL', () => {
    process.env['MORRISCODE_PUBLIC_URL'] = 'javascript:alert(1)'

    expect(() => getMcpOAuthRedirectUri()).toThrow(/http or https/)
  })

  it('rejects a value that is not a URL at all', () => {
    process.env['MORRISCODE_PUBLIC_URL'] = 'not a url'

    expect(() => getMcpOAuthRedirectUri()).toThrow(/not a valid URL/)
  })
})
