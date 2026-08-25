import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import type { AppModeConfig, AppModeSetInput } from '../../src/lib/desktopHost/types'

const APP_MODE_FILE = 'app-mode.json'
const PORTABLE_DATA_DIR_NAME = 'cc-haha-data'
const PORTABLE_WEBVIEW_DIR_NAME = 'EBWebView'
const PORTABLE_ELECTRON_USER_DATA_DIR_NAME = 'electron-user-data'
const SYSTEM_USER_DATA_ENV = 'CC_HAHA_SYSTEM_USER_DATA_DIR'

export type AppModeAppLike = {
  getPath(name: 'exe' | 'home' | 'userData'): string
  setPath?(name: 'userData', value: string): void
}

type PersistedAppModeConfig = {
  mode?: string
  /** Legacy field. Earlier builds wrote custom data directories as portable_dir. */
  portable_dir?: string | null
  custom_dir?: string | null
}

export function systemClaudeConfigDir(app: AppModeAppLike): string {
  return path.join(app.getPath('home'), '.claude')
}

export function portableDataDir(app: AppModeAppLike): string {
  return path.join(path.dirname(app.getPath('exe')), PORTABLE_DATA_DIR_NAME)
}

function portableModeFile(app: AppModeAppLike): string {
  return path.join(portableDataDir(app), APP_MODE_FILE)
}

function readAppModeConfigFile(file: string): PersistedAppModeConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as PersistedAppModeConfig
    return {
      mode: typeof parsed.mode === 'string' ? parsed.mode.toLowerCase() : 'default',
      portable_dir: typeof parsed.portable_dir === 'string' ? parsed.portable_dir.trim() : null,
      custom_dir: typeof parsed.custom_dir === 'string' ? parsed.custom_dir.trim() : null,
    }
  } catch {
    return null
  }
}

function readAppModeConfig(configDir: string): PersistedAppModeConfig | null {
  return readAppModeConfigFile(path.join(configDir, APP_MODE_FILE))
}

function writeJsonFileAtomically(target: string, config: PersistedAppModeConfig): void {
  const configDir = path.dirname(target)
  fs.mkdirSync(configDir, { recursive: true })
  const temporary = path.join(configDir, `.${path.basename(target)}.${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2))
    fs.renameSync(temporary, target)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function writeAppModeConfig(configDir: string, config: PersistedAppModeConfig): void {
  writeJsonFileAtomically(path.join(configDir, APP_MODE_FILE), config)
}

function removePortableModeFile(app: AppModeAppLike): void {
  fs.rmSync(portableModeFile(app), { force: true })
}

function assertWritableDataDir(configDir: string): void {
  try {
    fs.mkdirSync(configDir, { recursive: true })
    const probeDir = fs.mkdtempSync(path.join(configDir, '.cc-haha-write-test-'))
    try {
      fs.writeFileSync(path.join(probeDir, 'probe'), '')
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true })
    }
  } catch {
    throw new Error(`Data storage directory is not writable: ${configDir}`)
  }
}

function resolveWithExistingAncestor(inputPath: string): string {
  let existingPath = path.resolve(inputPath)
  const missingSegments: string[] = []
  while (!fs.existsSync(existingPath)) {
    const parent = path.dirname(existingPath)
    if (parent === existingPath) return path.resolve(inputPath)
    missingSegments.unshift(path.basename(existingPath))
    existingPath = parent
  }
  return path.join(fs.realpathSync.native(existingPath), ...missingSegments)
}

function isPathAtOrBelow(parentDir: string, candidateDir: string): boolean {
  const relative = path.relative(
    resolveWithExistingAncestor(parentDir),
    resolveWithExistingAncestor(candidateDir),
  )
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function normalizedCustomDir(app: AppModeAppLike, value: string | null | undefined): string {
  const selectedDir = value?.trim()
  if (!selectedDir) throw new Error('Choose an absolute custom data directory')
  if (!path.isAbsolute(selectedDir)) throw new Error('Custom data storage must use an absolute path')

  const normalized = path.resolve(selectedDir)
  if (isPathAtOrBelow(path.dirname(app.getPath('exe')), normalized)) {
    throw new Error('Custom data storage must stay outside the application install directory')
  }
  return normalized
}

function normalizedPortableDir(app: AppModeAppLike): string {
  return path.resolve(portableDataDir(app))
}

function externallyControlled(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CLAUDE_CONFIG_DIR && env.CC_HAHA_APP_PORTABLE_DIR !== '1')
}

// The app-managed data-dir selection is process-local derived state; persisted
// app-mode.json files stay the source of truth. Strip it before this environment
// reaches another process (app.relaunch(), the NSIS installer spawned by
// quitAndInstall()), otherwise the child would trust a snapshot that may no
// longer match the persisted mode (#1160).
export function clearAppManagedPortableEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.CC_HAHA_APP_PORTABLE_DIR !== '1') return
  delete env.CLAUDE_CONFIG_DIR
  delete env.CC_HAHA_APP_PORTABLE_DIR
  delete env.WEBVIEW2_USER_DATA_FOLDER
  delete env[SYSTEM_USER_DATA_ENV]
}

function appModeStorageDir(app: AppModeAppLike, env: NodeJS.ProcessEnv = process.env): string {
  return env[SYSTEM_USER_DATA_ENV]?.trim() || app.getPath('userData')
}

function customDirFromConfig(app: AppModeAppLike, config: PersistedAppModeConfig | null): string | null {
  if (!config) return null
  // Backward compatibility: legacy `mode: portable + portable_dir` meant
  // "custom data directory", not true install-adjacent portable mode.
  if (config.mode !== 'custom' && config.mode !== 'portable') return null
  const configuredDir = config.custom_dir || config.portable_dir
  if (!configuredDir || !path.isAbsolute(configuredDir)) return null
  try {
    return normalizedCustomDir(app, configuredDir)
  } catch {
    return null
  }
}

export function determineStartupConfigDir(
  app: AppModeAppLike,
  env: NodeJS.ProcessEnv = process.env,
): { source: 'custom' | 'portable', dir: string } | null {
  if (env.CLAUDE_CONFIG_DIR) return null

  const portableConfig = readAppModeConfigFile(portableModeFile(app))
  if (portableConfig?.mode === 'portable') {
    return { source: 'portable', dir: normalizedPortableDir(app) }
  }

  const userConfig = readAppModeConfig(appModeStorageDir(app, env))
  if (userConfig?.mode === 'portable' && !userConfig.custom_dir && !userConfig.portable_dir) {
    return { source: 'portable', dir: normalizedPortableDir(app) }
  }
  const customDir = customDirFromConfig(app, userConfig)
  return customDir ? { source: 'custom', dir: customDir } : null
}

export function determineStartupPortableDir(
  app: AppModeAppLike,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const startup = determineStartupConfigDir(app, env)
  return startup?.dir ?? null
}

export function applyStartupPortableMode(
  app: AppModeAppLike,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // app.relaunch() inherits process.env. Discard the previous app-managed
  // selection so persisted mode records remain authoritative.
  clearAppManagedPortableEnv(env)
  if (env.CLAUDE_CONFIG_DIR) {
    env.CLAUDE_CONFIG_DIR = normalizedCustomDir(app, env.CLAUDE_CONFIG_DIR)
    return null
  }
  const startup = determineStartupConfigDir(app, env)
  if (!startup) return null

  const webViewDataDir = path.join(startup.dir, PORTABLE_WEBVIEW_DIR_NAME)
  fs.mkdirSync(webViewDataDir, { recursive: true })
  if (startup.source === 'portable') {
    env[SYSTEM_USER_DATA_ENV] = env[SYSTEM_USER_DATA_ENV]?.trim() || app.getPath('userData')
    const electronUserData = path.join(startup.dir, PORTABLE_ELECTRON_USER_DATA_DIR_NAME)
    fs.mkdirSync(electronUserData, { recursive: true })
    app.setPath?.('userData', electronUserData)
  }
  env.CLAUDE_CONFIG_DIR = startup.dir
  env.CC_HAHA_APP_PORTABLE_DIR = '1'
  env.WEBVIEW2_USER_DATA_FOLDER = webViewDataDir
  return startup.dir
}

export function getAppMode(
  app: AppModeAppLike,
  env: NodeJS.ProcessEnv = process.env,
): AppModeConfig {
  const appManagedEnv = env.CC_HAHA_APP_PORTABLE_DIR === '1'
  const envConfigDir = env.CLAUDE_CONFIG_DIR && !appManagedEnv
    ? normalizedCustomDir(app, env.CLAUDE_CONFIG_DIR)
    : null
  const startupEnv = appManagedEnv ? { ...env, CLAUDE_CONFIG_DIR: undefined } : env
  const startup = envConfigDir ? null : determineStartupConfigDir(app, startupEnv)
  const portableDir = normalizedPortableDir(app)
  if (envConfigDir) {
    return {
      mode: 'custom',
      customDir: envConfigDir,
      portableDataDir: portableDir,
      activeConfigDir: envConfigDir,
      configDirSource: 'environment',
    }
  }
  if (startup) {
    return {
      mode: startup.source === 'portable' ? 'portable' : 'custom',
      customDir: startup.source === 'custom' ? startup.dir : null,
      portableDataDir: portableDir,
      activeConfigDir: startup.dir,
      configDirSource: startup.source,
    }
  }

  return {
    mode: 'default',
    customDir: null,
    portableDataDir: portableDir,
    activeConfigDir: systemClaudeConfigDir(app),
    configDirSource: 'system',
  }
}

export function setAppMode(
  app: AppModeAppLike,
  input: AppModeSetInput,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (externallyControlled(env)) {
    throw new Error('CLAUDE_CONFIG_DIR is controlled by the launch environment')
  }

  if (input.mode === 'default') {
    writeAppModeConfig(appModeStorageDir(app, env), { mode: 'default', custom_dir: null, portable_dir: null })
    removePortableModeFile(app)
    return
  }

  if (input.mode === 'portable') {
    const selectedDir = normalizedPortableDir(app)
    if (fs.existsSync(selectedDir) && !fs.statSync(selectedDir).isDirectory()) {
      throw new Error(`Portable data storage path is not a directory: ${selectedDir}`)
    }
    assertWritableDataDir(selectedDir)
    writeJsonFileAtomically(portableModeFile(app), { mode: 'portable', custom_dir: null, portable_dir: null })
    writeAppModeConfig(appModeStorageDir(app, env), { mode: 'portable', custom_dir: null, portable_dir: null })
    return
  }

  if (input.mode !== 'custom') throw new Error(`Unsupported app mode: ${String(input.mode)}`)

  const selectedDir = normalizedCustomDir(app, input.customDir)
  if (fs.existsSync(selectedDir) && !fs.statSync(selectedDir).isDirectory()) {
    throw new Error(`Custom data storage path is not a directory: ${selectedDir}`)
  }
  assertWritableDataDir(selectedDir)
  writeAppModeConfig(appModeStorageDir(app, env), {
    mode: 'custom',
    custom_dir: selectedDir,
    portable_dir: null,
  })
  removePortableModeFile(app)
}
