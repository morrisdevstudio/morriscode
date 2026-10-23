import { describe, expect, it } from 'vitest'
import { assertSafeArchiveEntries, isSafeArchiveEntry, normalizeArchiveEntry } from './archive.js'

describe('release archive entries', () => {
  it('accepts nested relative paths', () => {
    expect(isSafeArchiveEntry('dist/cli/index.js')).toBe(true)
    expect(isSafeArchiveEntry('./dist/cli/index.js')).toBe(false)
    expect(normalizeArchiveEntry('./dist/cli/index.js')).toBe('dist/cli/index.js')
    expect(isSafeArchiveEntry('node_modules/pkg/package.json')).toBe(true)
  })

  it('rejects absolute paths, drive prefixes and traversal', () => {
    expect(isSafeArchiveEntry('/etc/passwd')).toBe(false)
    expect(isSafeArchiveEntry('C:\\Windows\\system.ini')).toBe(false)
    expect(isSafeArchiveEntry('../outside.txt')).toBe(false)
    expect(isSafeArchiveEntry('dist/../../outside.txt')).toBe(false)
    expect(isSafeArchiveEntry('dist//index.js')).toBe(false)
  })

  it('rejects a whole unsafe archive', () => {
    expect(() => assertSafeArchiveEntries(['dist/index.js', '..\\evil.js'])).toThrow(/Unsafe archive entry/)
    expect(() => assertSafeArchiveEntries(['dist/index.js', 'dist/app.js'])).not.toThrow()
  })
})
