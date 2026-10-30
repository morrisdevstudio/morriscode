import { startDevWatcher } from '../src/cli/dev-launcher.js'

process.exit(await startDevWatcher(process.argv.slice(2)))
