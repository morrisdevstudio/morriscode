// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SkillLibraryPanel } from './SkillLibraryPanel'

vi.mock('../shared/DirectoryBrowser', () => ({
  DirectoryBrowser: ({ onSelect }: { onSelect: (path: string) => void }) => (
    <button onClick={() => onSelect('/Users/test/Shared Skills')}>Select mocked folder</button>
  ),
}))

describe('SkillLibraryPanel', () => {
  it('shows the default global folder and lets it be changed', () => {
    const onSelect = vi.fn()
    render(
      <SkillLibraryPanel
        selectedDirectory={{
          configuredPath: '/Users/test/.config/morriscode/skills',
          resolvedPath: '/Users/test/.config/morriscode/skills',
          available: true,
          custom: false,
        }}
        onSelect={onSelect}
        onRemove={vi.fn()}
        onRefresh={vi.fn()}
        onInstall={vi.fn()}
      />,
    )
    expect(screen.getByText('/Users/test/.config/morriscode/skills')).toBeTruthy()
    expect(screen.getByText('Drop one skill folder here')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Change folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select mocked folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Trust folder' }))
    expect(onSelect).toHaveBeenCalledWith('/Users/test/Shared Skills')
  })
})
