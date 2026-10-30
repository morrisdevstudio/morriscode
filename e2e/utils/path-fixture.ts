import { mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Create disposable paths outside the workdir and automatically allowed temp roots. */
export async function createOutsidePathFixture() {
  const parent = resolve(homedir())
  const directory = resolve(await mkdtemp(join(parent, '.morriscode-e2e-')))
  if (dirname(directory) !== parent || !basename(directory).startsWith('.morriscode-e2e-')) {
    throw new Error('Outside path fixture must be a dedicated directory under the user home')
  }
  return {
    path: (name: string) => join(directory, name),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}
