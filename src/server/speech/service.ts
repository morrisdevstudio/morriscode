import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { access, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import type { SpeechInstallStage, SpeechLanguage, SpeechStatus } from '../../shared/speech.js'

const MODEL_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.int8.onnx'
const VOICES_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin'
const MODEL_FILE = 'kokoro-v1.0.int8.onnx'
const VOICES_FILE = 'voices-v1.0.bin'
const MIN_MODEL_BYTES = 100 * 1024 * 1024
const MIN_VOICES_BYTES = 1 * 1024 * 1024
const MODEL_SHA256 = 'ae315a79b623f244700e4afb9246c46a26066782e049ba174bf3ba433970ee9c'
const VOICES_SHA256 = 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d'
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1000
const SYNTHESIS_TIMEOUT_MS = 120 * 1000
const WORKER_START_TIMEOUT_MS = 30 * 1000
const PYTHON_PACKAGES = [
  'kokoro-onnx==0.6.1',
  'onnxruntime==1.31.0',
  'espeakng-loader==0.2.4',
  'phonemizer==3.4.0',
  'numpy==2.5.4',
]

export interface SpeechGeneration {
  audio: Buffer
  durationMs: number
  generationMs: number
}

export interface SpeechEngine {
  getStatus(): SpeechStatus
  install(): SpeechStatus
  generate(text: string, language: SpeechLanguage, requestId?: string): Promise<SpeechGeneration>
  cancel(requestId: string): void
  close(): void
}

export class SpeechNotInstalledError extends Error {
  constructor() {
    super('speech engine is not installed')
    this.name = 'SpeechNotInstalledError'
  }
}

export class SpeechBusyError extends Error {
  constructor() {
    super('speech engine is busy')
    this.name = 'SpeechBusyError'
  }
}

export class SpeechCanceledError extends Error {
  constructor() {
    super('speech generation canceled')
    this.name = 'SpeechCanceledError'
  }
}

interface ActiveSynthesis {
  id: string
  resolve: (result: SpeechGeneration) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

interface WorkerMessage {
  type?: string
  id?: string
  audio?: string
  error?: string
  generationMs?: number
  durationMs?: number
}

export interface SpeechServiceOptions {
  dataDir: string
  /** Override the data subdirectory. Intended for isolated verification. */
  runtimeDir?: string
  workerScript?: string
  fetchImpl?: typeof fetch
  idleTimeoutMs?: number
}

function pythonExecutable(venvDir: string): string {
  return process.platform === 'win32' ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python')
}

function resolveWorkerScript(explicit?: string): string {
  if (explicit) return explicit
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(moduleDir, 'kokoro_worker.py'),
    join(moduleDir, 'speech', 'kokoro_worker.py'),
    join(moduleDir, 'server', 'speech', 'kokoro_worker.py'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

async function fileIsLargeEnough(path: string, minimum: number): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size >= minimum
  } catch {
    return false
  }
}

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, UV_LINK_MODE: 'copy', PYTHONUTF8: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000)
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      reject(new Error(error.code === 'ENOENT' ? 'uv is not available' : 'speech installer failed'))
    })
    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(
          new Error(stderr.trim() ? 'speech installer failed' : 'speech installer exited with code ' + String(code)),
        )
      }
    })
  })
}

export class SpeechService implements SpeechEngine {
  private readonly runtimeDir: string
  private readonly venvDir: string
  private readonly modelPath: string
  private readonly voicesPath: string
  private readonly workerScript: string
  private readonly fetchImpl: typeof fetch
  private readonly idleTimeoutMs: number
  private readonly idleTimers = new Set<NodeJS.Timeout>()
  private worker: ChildProcessWithoutNullStreams | null = null
  private workerReady: Promise<void> | null = null
  private startResolve: (() => void) | null = null
  private startReject: ((error: Error) => void) | null = null
  private active: ActiveSynthesis | null = null
  private pendingId: string | null = null
  private busy = false
  private stage: SpeechInstallStage = 'idle'
  private progress = 0
  private installError: string | null = null
  private installing = false
  private idleTimer: NodeJS.Timeout | null = null
  private stdoutBuffer = ''

  constructor(options: SpeechServiceOptions) {
    this.runtimeDir = options.runtimeDir ?? join(options.dataDir, 'speech')
    this.venvDir = join(this.runtimeDir, 'venv')
    this.modelPath = join(this.runtimeDir, 'models', MODEL_FILE)
    this.voicesPath = join(this.runtimeDir, 'models', VOICES_FILE)
    this.workerScript = resolveWorkerScript(options.workerScript)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  }

  getStatus(): SpeechStatus {
    if (this.installing) {
      return {
        state: 'installing',
        installed: false,
        stage: this.stage,
        progress: this.progress,
        cpuOnly: true,
        voice: 'ff_siwis',
      }
    }
    if (this.installError) {
      return {
        state: 'error',
        installed: false,
        stage: this.stage,
        progress: this.progress,
        cpuOnly: true,
        voice: 'ff_siwis',
        error: this.installError,
      }
    }
    const installed = this.isInstalled()
    return {
      state: installed ? 'ready' : 'not-installed',
      installed,
      stage: installed ? 'verifying' : 'idle',
      progress: installed ? 100 : 0,
      cpuOnly: true,
      voice: 'ff_siwis',
    }
  }

  install(): SpeechStatus {
    if (this.installing) return this.getStatus()
    if (this.isInstalled()) return this.getStatus()
    this.installing = true
    this.installError = null
    this.progress = 0
    this.stage = 'preparing'
    this.setStage('preparing', 2)
    void this.runInstall()
    return this.getStatus()
  }

  async generate(text: string, language: SpeechLanguage, requestId = randomUUID()): Promise<SpeechGeneration> {
    if (!this.isInstalled()) throw new SpeechNotInstalledError()
    if (this.active || this.busy) throw new SpeechBusyError()

    this.busy = true
    this.pendingId = requestId
    try {
      const worker = await this.ensureWorker()
      if (this.pendingId !== requestId) throw new SpeechCanceledError()
      this.pendingId = null
      return new Promise<SpeechGeneration>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.cancel(requestId)
          reject(new Error('speech synthesis timed out'))
        }, SYNTHESIS_TIMEOUT_MS)
        timeout.unref()
        this.active = { id: requestId, resolve, reject, timeout }
        this.busy = false
        this.clearIdleTimer()
        worker.stdin.write(JSON.stringify({ id: requestId, text, language }) + '\n')
      })
    } catch (error) {
      if (this.pendingId === requestId) this.pendingId = null
      this.busy = false
      throw error
    }
  }

  cancel(requestId: string): void {
    if (this.pendingId === requestId) {
      this.pendingId = null
      this.stopWorker()
      return
    }
    if (!this.active || this.active.id !== requestId) return
    const active = this.active
    this.active = null
    clearTimeout(active.timeout)
    active.reject(new SpeechCanceledError())
    this.stopWorker()
  }

  close(): void {
    this.pendingId = null
    this.busy = false
    const active = this.active
    this.active = null
    if (active) {
      clearTimeout(active.timeout)
      active.reject(new SpeechCanceledError())
    }
    this.stopWorker()
  }

  private isInstalled(): boolean {
    if (!existsSync(this.modelPath) || !existsSync(this.voicesPath)) return false
    if (!existsSync(this.workerScript) || !existsSync(pythonExecutable(this.venvDir))) return false
    return true
  }

  private setStage(stage: SpeechInstallStage, progress: number): void {
    this.stage = stage
    this.progress = Math.max(this.progress, Math.min(100, progress))
  }

  private async runInstall(): Promise<void> {
    try {
      await mkdir(join(this.runtimeDir, 'models'), { recursive: true })
      this.setStage('creating-environment', 8)
      await runCommand('uv', ['venv', '--python', '3.12', this.venvDir], this.runtimeDir)

      const python = pythonExecutable(this.venvDir)
      this.setStage('installing-engine', 18)
      await runCommand('uv', ['pip', 'install', '--python', python, ...PYTHON_PACKAGES], this.runtimeDir)

      this.setStage('downloading-model', 38)
      await this.download(MODEL_URL, this.modelPath, MIN_MODEL_BYTES, MODEL_SHA256, 38, 76)
      this.setStage('downloading-voices', 78)
      await this.download(VOICES_URL, this.voicesPath, MIN_VOICES_BYTES, VOICES_SHA256, 78, 94)
      this.setStage('verifying', 96)

      if (!(await fileIsLargeEnough(this.modelPath, MIN_MODEL_BYTES))) {
        throw new Error('downloaded speech model is incomplete')
      }
      if (!(await fileIsLargeEnough(this.voicesPath, MIN_VOICES_BYTES))) {
        throw new Error('downloaded speech voices are incomplete')
      }
      await access(python, constants.X_OK)
      await writeFile(
        join(this.runtimeDir, 'manifest.json'),
        JSON.stringify({ engine: 'kokoro-onnx', version: '0.6.1', model: 'int8', cpuOnly: true }),
        'utf8',
      )
      this.progress = 100
      this.stage = 'idle'
    } catch (error) {
      this.installError = error instanceof Error ? error.message : 'speech installation failed'
    } finally {
      this.installing = false
    }
  }

  private async download(
    url: string,
    destination: string,
    minimumBytes: number,
    expectedSha256: string,
    progressStart: number,
    progressEnd: number,
  ): Promise<void> {
    const temporary = destination + '.part'
    await rm(temporary, { force: true })
    const response = await this.fetchImpl(url)
    if (!response.ok || !response.body) {
      throw new Error('speech download failed')
    }
    try {
      const file = await open(temporary, 'w')
      try {
        const total = Number(response.headers.get('content-length')) || 0
        const reader = response.body.getReader()
        const hash = createHash('sha256')
        let received = 0
        while (true) {
          const next = await reader.read()
          if (next.done) break
          const buffer = Buffer.from(next.value)
          hash.update(buffer)
          await file.write(buffer)
          received += buffer.length
          if (total > 0) {
            const ratio = received / total
            this.setStage(
              destination.endsWith(MODEL_FILE) ? 'downloading-model' : 'downloading-voices',
              progressStart + Math.round((progressEnd - progressStart) * ratio),
            )
          }
        }
        if (received < minimumBytes) {
          throw new Error('speech download is incomplete')
        }
        if (hash.digest('hex') !== expectedSha256) {
          throw new Error('speech download failed integrity verification')
        }
      } finally {
        await file.close()
      }
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    await rm(destination, { force: true })
    await rename(temporary, destination)
  }

  private async ensureWorker(): Promise<ChildProcessWithoutNullStreams> {
    if (this.worker && this.workerReady) {
      await this.workerReady
      return this.worker
    }

    const python = pythonExecutable(this.venvDir)
    const child = spawn(python, [this.workerScript], {
      cwd: this.runtimeDir,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        MORRISCODE_SPEECH_MODEL: this.modelPath,
        MORRISCODE_SPEECH_VOICES: this.voicesPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.worker = child
    this.stdoutBuffer = ''
    child.stdout.on('data', (chunk: Buffer) => this.consumeWorkerOutput(child, chunk))
    child.stderr.on('data', () => {
      // Kokoro may write diagnostics here. Never forward them: they can carry
      // request text on some phonemizer failures.
    })
    child.once('error', (error) => this.handleWorkerFailure(child, error))
    child.once('exit', () => this.handleWorkerFailure(child, new Error('speech worker stopped')))

    this.workerReady = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('speech worker did not start'))
        this.stopWorker()
      }, WORKER_START_TIMEOUT_MS)
      timeout.unref()
      this.startResolve = () => {
        clearTimeout(timeout)
        resolve()
      }
      this.startReject = (error) => {
        clearTimeout(timeout)
        reject(error)
      }
    })
    try {
      await this.workerReady
      return child
    } catch (error) {
      this.workerReady = null
      throw error
    }
  }

  private consumeWorkerOutput(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.worker !== child) return
    this.stdoutBuffer += chunk.toString('utf8')
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line) this.handleWorkerMessage(line)
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  private handleWorkerMessage(line: string): void {
    let message: WorkerMessage
    try {
      message = JSON.parse(line) as WorkerMessage
    } catch {
      return
    }
    if (message.type === 'ready') {
      this.startResolve?.()
      this.startResolve = null
      this.startReject = null
      this.scheduleIdleShutdown()
      return
    }
    const active = this.active
    if (!active || message.id !== active.id) return
    this.active = null
    clearTimeout(active.timeout)
    if (message.type === 'audio' && message.audio) {
      active.resolve({
        audio: Buffer.from(message.audio, 'base64'),
        durationMs: message.durationMs ?? 0,
        generationMs: message.generationMs ?? 0,
      })
      this.scheduleIdleShutdown()
    } else {
      active.reject(new Error(message.error ?? 'speech synthesis failed'))
      this.scheduleIdleShutdown()
    }
  }

  private handleWorkerFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.worker !== child) return
    this.stopWorker(error)
    const active = this.active
    this.active = null
    if (active) {
      clearTimeout(active.timeout)
      active.reject(error)
    }
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer()
    const timer = setTimeout(() => {
      this.idleTimers.delete(timer)
      if (!this.active) this.stopWorker()
    }, this.idleTimeoutMs)
    timer.unref()
    this.idleTimer = timer
    this.idleTimers.add(timer)
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimers.delete(this.idleTimer)
    this.idleTimer = null
  }

  private stopWorker(reason: Error = new SpeechCanceledError()): void {
    this.clearIdleTimer()
    for (const timer of this.idleTimers) clearTimeout(timer)
    this.idleTimers.clear()
    const worker = this.worker
    this.worker = null
    this.workerReady = null
    this.stdoutBuffer = ''
    const rejectStart = this.startReject
    this.startResolve = null
    this.startReject = null
    rejectStart?.(reason)
    if (!worker) return
    worker.kill()
  }
}
