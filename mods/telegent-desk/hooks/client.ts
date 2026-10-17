import type { EngineInterface, PluginOptions } from 'claude-code'

// `root` is the connected project: the folder of the nearest `.telegent.json` above the
// session, else the session's folder. A `config` option may live anywhere, so it is no root.
// `isFound`: the client or the config came from a `.telegent.json` found on disk, which a
// cloned repository could ship: it names the script that runs, the server and the token file
// sent there, so the person confirms them before anything runs. `trust` keys that consent and
// changes with any of them; `server` is shown in the question.
export type ClientSettings = {
  python: string
  client: string
  config: string
  cwd: string
  root: string
  isFound: boolean
  server: string
  trust: string
}

export type ClientRun = { isOk: boolean; isTruncated: boolean; code: number; stdout: string; stderr: string }

// tg.py retries and looks up a moved server on its own (up to four tries with 30 s
// requests); a shorter limit would kill it before it reaches the new address.
export const CLIENT_TIMEOUT_MS = 300_000

// A guarded edit waits for this at most, then trusts the last good claims list.
export const GUARD_TIMEOUT_MS = 5_000

function text(options: PluginOptions, key: string): string {
  const value = options[key]

  return typeof value === 'string' ? value.trim() : ''
}

// Paths may be POSIX or Windows (`C:\work\project`); a root has no parent.
export function parentDir(dir: string): string | undefined {
  const trimmed = dir.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut < 0) {
    return undefined
  }
  const up = trimmed.slice(0, cut)
  if (up === '') {
    return '/'
  }

  return /^[A-Za-z]:$/.test(up) ? `${up}\\` : up
}

export function absolutePath(path: string, base: string): string {
  return /^([A-Za-z]:)?[\\/]/.test(path) ? path : joinPath(base, path.replace(/^\.[\\/]/, ''))
}

export function joinPath(dir: string, name: string): string {
  return /[\\/]$/.test(dir) ? `${dir}${name}` : `${dir}/${name}`
}

async function findConfig($: EngineInterface, cwd: string): Promise<string | undefined> {
  for (let dir: string | undefined = cwd; dir !== undefined; dir = parentDir(dir)) {
    const path = joinPath(dir, '.telegent.json')
    if (await $.fs.exists(path).catch(() => false)) {
      return path
    }
  }

  return undefined
}

async function projectRoot($: EngineInterface, cwd: string): Promise<string> {
  const found = await findConfig($, cwd)

  return (found === undefined ? undefined : parentDir(found)) ?? cwd
}

// The token never passes through the mod: tg.py reads it from its own config.
export async function resolveSettings(
  $: EngineInterface,
  options: PluginOptions,
  cwd: string,
): Promise<ClientSettings | undefined> {
  const python = text(options, 'python') || 'python3'
  const root = await projectRoot($, cwd)
  let client = text(options, 'client')
  let config = text(options, 'config')
  if (client !== '' && config !== '') {
    return { python, client, config, cwd, root, isFound: false, server: '', trust: '' }
  }
  const found = config || (await findConfig($, cwd))
  if (found === undefined) {
    return client === '' ? undefined : { python, client, config, cwd, root, isFound: false, server: '', trust: '' }
  }
  config = found
  // tg.py reads its config as utf-8-sig, so a Windows editor's BOM is valid there too.
  const saved = JSON.parse((await $.fs.read(found)).replace(/^\uFEFF/, '')) as Record<string, unknown> | null
  const field = (key: string): string => (typeof saved?.[key] === 'string' ? (saved[key] as string) : '')
  if (client === '') {
    if (field('client_path') === '') {
      return undefined
    }
    // A relative client_path means the config's folder: the path that is allowed is the
    // path that runs, whatever folder the session starts in.
    client = absolutePath(field('client_path'), parentDir(absolutePath(found, cwd)) ?? cwd)
  }
  const server = field('server')
  const trust = [config, client, server, field('token_file'), field('url_source')].join('\n')

  return { python, client, config, cwd, root, isFound: true, server, trust }
}

export function clientArgv(settings: ClientSettings, args: readonly string[]): string[] {
  const config = settings.config === '' ? [] : ['--config', settings.config]

  return [settings.python, '-X', 'utf8', settings.client, ...config, ...args]
}

export async function runClient(
  $: EngineInterface,
  settings: ClientSettings,
  args: readonly string[],
  stdin?: string,
  timeoutMs = CLIENT_TIMEOUT_MS,
): Promise<ClientRun> {
  try {
    const run = await $.process.run(clientArgv(settings, args), {
      cwd: settings.cwd,
      timeoutMs,
      ...(stdin === undefined ? {} : { stdin }),
    })

    if (run.isStdoutTruncated) {
      return { isOk: false, isTruncated: true, code: run.exitCode, stdout: '', stderr: 'tg.py: ответ больше 4 МиБ' }
    }

    return { isOk: run.exitCode === 0, isTruncated: false, code: run.exitCode, stdout: run.stdout, stderr: run.stderr }
  } catch (error) {
    const stderr = error instanceof Error ? error.message : String(error)

    return { isOk: false, isTruncated: false, code: -1, stdout: '', stderr }
  }
}
