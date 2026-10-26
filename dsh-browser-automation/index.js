/**
 * dsh-browser-automation
 *
 * Host-side browser automation over the Chrome DevTools Protocol. It drives a real
 * Edge/Chrome window backed by a persistent, user-owned profile: the user signs in
 * once (including any captcha) and later tool calls reuse those cookies.
 *
 * The plugin exposes page reading, an element snapshot with stable refs, clicking,
 * typing, key presses, scrolling, screenshots, tab management, file upload, and
 * cookie-authenticated downloads. It never injects arbitrary JavaScript supplied by
 * the model; every operation is a fixed script.
 *
 * @module dsh-browser-automation
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'browser-automation'
export const inject = ['tools']

const DEFAULT_PORT = 9333
const LAUNCH_TIMEOUT_MS = 25000
const PAGE_TIMEOUT_MS = 20000
const MAX_ELEMENTS = 300
const MAX_TEXT = 20000

/** Last target id and snapshot ref map, shared by the tools of one plugin instance. */
const state = {
  targetId: undefined,
  refs: new Map(),
  browserConn: undefined,
  browserWsUrl: undefined,
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Resolve deployment defaults from the row config.
 * @param {Record<string, unknown>} config row config
 */
function settings(config = {}) {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return {
    port: Number.isInteger(config.port) && config.port > 0 ? config.port : DEFAULT_PORT,
    profileDir: typeof config.userDataDir === 'string' && config.userDataDir.length > 0
      ? config.userDataDir
      : join(localAppData, 'dsh-browser-profile'),
    downloadDir: typeof config.downloadDir === 'string' && config.downloadDir.length > 0
      ? config.downloadDir
      : join(homedir(), 'Downloads', 'dsh-browser'),
    browserPath: typeof config.browserPath === 'string' ? config.browserPath : '',
    headless: config.headless === true,
  }
}

/** Common Edge/Chrome install locations on Windows, then PATH fallbacks. */
function findBrowserExecutable(configured) {
  if (configured) {
    if (existsSync(configured)) return configured
    throw new Error(`Configured browserPath does not exist: ${configured}`)
  }
  const candidates = [
    join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  throw new Error('No Edge or Chrome executable found. Set the plugin config field browserPath.')
}

/** @param {ReturnType<typeof settings>} cfg */
function versionUrl(cfg) {
  return `http://127.0.0.1:${cfg.port}/json/version`
}

/** @param {ReturnType<typeof settings>} cfg */
async function readVersion(cfg) {
  const res = await fetch(versionUrl(cfg), { signal: AbortSignal.timeout(2000) })
  if (!res.ok) throw new Error(`CDP endpoint returned HTTP ${res.status}`)
  return res.json()
}

/** @param {ReturnType<typeof settings>} cfg */
async function pageTargets(cfg) {
  const res = await fetch(`http://127.0.0.1:${cfg.port}/json/list`, { signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error(`CDP target list returned HTTP ${res.status}`)
  const targets = await res.json()
  return targets.filter((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
}

/** @type {Promise<void> | undefined} */
let launching

/**
 * Make sure the automation browser is running and exposing CDP on the configured port.
 * @param {ReturnType<typeof settings>} cfg
 */
async function ensureBrowser(cfg) {
  try {
    await readVersion(cfg)
    return
  } catch {
    // Not running yet, or the profile is already owned by another process.
  }
  if (launching) {
    await launching
    return
  }
  launching = (async () => {
    const executable = findBrowserExecutable(cfg.browserPath)
    await mkdir(cfg.profileDir, { recursive: true })
    const args = [
      `--remote-debugging-port=${cfg.port}`,
      `--user-data-dir=${cfg.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ]
    if (cfg.headless) args.push('--headless=new')
    args.push('about:blank')
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(400)
      try {
        await readVersion(cfg)
        return
      } catch {
        // keep waiting
      }
    }
    throw new Error(
      `The automation browser did not expose CDP on 127.0.0.1:${cfg.port} within ${LAUNCH_TIMEOUT_MS / 1000}s. `
      + 'Close any Edge window using the automation profile, or change the port in the plugin config.',
    )
  })().finally(() => {
    launching = undefined
  })
  await launching
}

/**
 * A minimal CDP connection over the page or browser WebSocket.
 */
class Cdp {
  /**
   * @param {WebSocket} ws
   */
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.waiters = new Set()
    this.closed = false
    ws.addEventListener('message', (event) => this.#onMessage(event))
    ws.addEventListener('close', () => {
      this.closed = true
      for (const pending of this.pending.values()) pending.reject(new Error('CDP connection closed'))
      this.pending.clear()
    })
    ws.addEventListener('error', () => {
      this.closed = true
    })
  }

  /**
   * @param {string} url
   * @param {number} [timeoutMs]
   */
  static async open(url, timeoutMs = 10000) {
    const ws = new WebSocket(url)
    const connection = new Cdp(ws)
    await new Promise((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) {
        resolve()
        return
      }
      const timer = setTimeout(() => reject(new Error('Timed out connecting to CDP')), timeoutMs)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error(`Could not connect to CDP at ${url}`))
      }, { once: true })
    })
    return connection
  }

  /** @param {MessageEvent} event */
  #onMessage(event) {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message || 'CDP command failed'))
      else pending.resolve(message.result || {})
      return
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.method === message.method) {
        this.waiters.delete(waiter)
        waiter.resolve(message.params || {})
      }
    }
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {number} [timeoutMs]
   */
  send(method, params = {}, timeoutMs = PAGE_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error('CDP connection is closed'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * @param {string} method
   * @param {number} [timeoutMs]
   */
  waitFor(method, timeoutMs = PAGE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        resolve: (params) => {
          clearTimeout(timer)
          resolve(params)
        },
      }
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error(`Timed out waiting for ${method}`))
      }, timeoutMs)
      this.waiters.add(waiter)
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      // already closed
    }
  }
}

/**
 * @param {ReturnType<typeof settings>} cfg
 */
async function withBrowser(cfg, operation) {
  const version = await readVersion(cfg)
  const cdp = await Cdp.open(version.webSocketDebuggerUrl)
  try {
    return await operation(cdp)
  } finally {
    cdp.close()
  }
}

/**
 * @param {ReturnType<typeof settings>} cfg
 * @param {string} [preferredId]
 */
async function currentTarget(cfg, preferredId = state.targetId) {
  const pages = await pageTargets(cfg)
  if (pages.length === 0) return createTarget(cfg, 'about:blank')
  const preferred = preferredId ? pages.find((target) => target.id === preferredId) : undefined
  // Internal pages (edge://, chrome://, about:blank) cannot be read or captured
  // reliably, so a real web page wins even when it is not the most recent target.
  if (preferred && /^https?:/i.test(preferred.url)) return preferred
  const webPages = pages.filter((target) => /^https?:/i.test(target.url))
  if (webPages.length > 0) {
    const fallback = webPages[webPages.length - 1]
    state.targetId = fallback.id
    return fallback
  }
  const fallback = preferred || pages[pages.length - 1]
  state.targetId = fallback.id
  return fallback
}

/**
 * @param {ReturnType<typeof settings>} cfg
 * @param {string} url
 */
async function createTarget(cfg, url) {
  const target = await withBrowser(cfg, async (cdp) => {
    const result = await cdp.send('Target.createTarget', { url })
    return result
  })
  const pages = await pageTargets(cfg)
  const created = pages.find((page) => page.id === target.targetId) || pages[pages.length - 1]
  if (created) state.targetId = created.id
  return created
}

/**
 * @param {ReturnType<typeof settings>} cfg
 * @param {string} targetId
 */
async function connectPage(cfg, targetId) {
  const pages = await pageTargets(cfg)
  const target = pages.find((page) => page.id === targetId)
  if (!target) throw new Error('The browser tab disappeared. Run browser_tabs and try again.')
  const cdp = await Cdp.open(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  return { cdp, target }
}

/**
 * A persistent browser-level CDP connection. Edge scopes Browser.setDownloadBehavior to
 * the browser session, so the connection must stay open while downloads are running.
 * @param {ReturnType<typeof settings>} cfg
 */
async function browserConnection(cfg) {
  const version = await readVersion(cfg)
  if (state.browserConn && !state.browserConn.closed && state.browserWsUrl === version.webSocketDebuggerUrl) {
    return state.browserConn
  }
  state.browserConn?.close()
  state.browserConn = await Cdp.open(version.webSocketDebuggerUrl)
  state.browserWsUrl = version.webSocketDebuggerUrl
  return state.browserConn
}

/**
 * Route downloads from the automation browser to the configured folder.
 * @param {ReturnType<typeof settings>} cfg
 */
async function setDownloadBehavior(cfg) {
  await mkdir(cfg.downloadDir, { recursive: true })
  const browser = await browserConnection(cfg)
  await browser.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: cfg.downloadDir,
    eventsEnabled: true,
  })
}

/** Flatten the frame tree into execution contexts that can be evaluated. */
async function frameContexts(cdp) {
  const { frameTree } = await cdp.send('Page.getFrameTree')
  const frames = []
  const walk = (node, depth) => {
    if (!node) return
    frames.push({ frameId: node.frame.id, url: node.frame.url, depth })
    for (const child of node.childFrames || []) walk(child, depth + 1)
  }
  walk(frameTree, 0)
  const contexts = []
  for (const frame of frames) {
    try {
      const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
        frameId: frame.frameId,
        worldName: 'dsh-automation',
      })
      contexts.push({ ...frame, contextId: executionContextId })
    } catch {
      // A detached or inaccessible frame is skipped.
    }
  }
  return contexts
}

/**
 * @param {Cdp} cdp
 * @param {number} contextId
 * @param {string} expression
 */
async function evaluateIn(cdp, contextId, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: false,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Page evaluation failed')
  }
  return result.result?.value
}

/** Read the current top-level title and URL. */
async function pageState(cdp) {
  try {
    const raw = await evaluateIn(cdp, undefined, 'JSON.stringify({ title: document.title, url: location.href })')
    return JSON.parse(raw)
  } catch {
    return { title: '', url: '' }
  }
}

const SNAPSHOT_JS = `(() => {
  const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
  };
  const nameOf = (el) => clean(
    el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder')
    || el.getAttribute('alt') || (el.tagName === 'INPUT' ? el.value : '')
    || el.innerText || el.textContent || ''
  );
  const selector = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,'
    + '[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],'
    + '[role="switch"],[onclick],[contenteditable="true"]';
  const picked = Array.from(document.querySelectorAll(selector)).filter(visible).slice(0, 140);
  picked.forEach((el, index) => el.setAttribute('data-dsh-ref', String(index + 1)));
  const elements = picked.map((el, index) => {
    const item = {
      ref: index + 1,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || ({
        A: 'link', BUTTON: 'button',
        INPUT: el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'input',
        SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button',
      }[el.tagName] || ''),
      name: nameOf(el).slice(0, 120),
    };
    if (el.href) item.href = el.href;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      item.type = el.type || 'text';
      if (el.value) item.value = String(el.value).slice(0, 120);
      if (el.placeholder) item.placeholder = el.placeholder;
      if (el.type === 'checkbox' || el.type === 'radio') item.checked = Boolean(el.checked);
    }
    if (el.disabled) item.disabled = true;
    if (el.tagName === 'SELECT') {
      item.value = el.value;
      item.options = Array.from(el.options).slice(0, 12).map((option) => clean(option.text));
    }
    return item;
  });
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4')).filter(visible).slice(0, 60)
    .map((heading) => ({ level: Number(heading.tagName[1]), text: clean(heading.innerText).slice(0, 160) }));
  return {
    title: document.title,
    url: location.href,
    scrollY: Math.round(window.scrollY),
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    text: (document.body ? (document.body.innerText || document.body.textContent) : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 5000),
    headings,
    elements,
  };
})()`

/**
 * Snapshot every frame, assign refs, and remember where each ref lives.
 * @param {Cdp} cdp
 */
async function snapshotPage(cdp, targetId) {
  const frames = await frameContexts(cdp)
  const refs = new Map()
  const elements = []
  const headings = []
  let text = ''
  let page = { title: '', url: '' }
  let scrollY = 0
  let scrollHeight = 0
  for (let index = 0; index < frames.length && index < 12; index++) {
    const frame = frames[index]
    try {
      const data = await evaluateIn(cdp, frame.contextId, SNAPSHOT_JS)
      if (!data) continue
      if (index === 0) {
        page = { title: data.title, url: data.url }
        scrollY = data.scrollY
        scrollHeight = data.scrollHeight
      }
      for (const element of data.elements || []) {
        if (elements.length >= MAX_ELEMENTS) break
        const ref = `f${index}r${element.ref}`
        refs.set(ref, {
          targetId,
          frameId: frame.frameId,
          contextId: frame.contextId,
          ref: element.ref,
          frameUrl: frame.url,
        })
        elements.push({ ...element, ref, frame: index })
      }
      for (const heading of data.headings || []) headings.push({ ...heading, frame: index })
      if (data.text) {
        text += (index === 0 ? '' : `\n\n--- frame ${index}: ${frame.url} ---\n`) + data.text
      }
    } catch {
      // A frame that changed during the snapshot is retried on the next call.
    }
  }
  state.refs = refs
  return {
    title: page.title,
    url: page.url,
    scrollY,
    scrollHeight,
    elements,
    headings,
    text: text.slice(0, MAX_TEXT),
    frameCount: frames.length,
  }
}

/**
 * Resolve a ref from the latest snapshot, or use the main frame for a CSS selector.
 * @param {Cdp} cdp
 * @param {string} ref
 */
function resolveRef(ref) {
  const entry = state.refs.get(String(ref))
  if (!entry) {
    throw new Error(`Unknown element ref "${ref}". Run browser_snapshot again after the page changes.`)
  }
  return entry
}

/** @param {Cdp} cdp */
async function mainContextId(cdp) {
  const frames = await frameContexts(cdp)
  if (frames.length === 0) throw new Error('No page frame is available')
  return frames[0].contextId
}

/** @param {string} value */
function clip(value, max = 500) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Render a snapshot as compact lines the model can reason about.
 * @param {any} value
 */
function renderSnapshot(value) {
  const lines = []
  lines.push(`Title: ${value.title || '(untitled)'}`)
  lines.push(`URL: ${value.url || '(none)'}`)
  if (value.headings?.length) {
    lines.push('', 'Headings:')
    for (const heading of value.headings.slice(0, 20)) {
      lines.push(`${'  '.repeat(Math.max(0, heading.level - 1))}H${heading.level} ${heading.text}`)
    }
  }
  if (value.elements?.length) {
    lines.push('', 'Interactive elements:')
    for (const element of value.elements) {
      const parts = [`[${element.ref}]`, element.role || element.tag]
      if (element.name) parts.push(JSON.stringify(clip(element.name, 120)))
      if (element.href) parts.push(`-> ${clip(element.href, 160)}`)
      if (element.value) parts.push(`value=${JSON.stringify(clip(element.value, 80))}`)
      if (element.checked !== undefined) parts.push(element.checked ? 'checked' : 'unchecked')
      if (element.disabled) parts.push('disabled')
      lines.push(parts.join(' '))
    }
  } else {
    lines.push('', 'No interactive elements found in the visible frames.')
  }
  return lines.join('\n')
}

/** @param {any} value */
function renderPage(value) {
  return `Title: ${value.title || '(untitled)'}\nURL: ${value.url || '(none)'}\n\n${value.text || '(no text)'}`
}

/**
 * @param {import('cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const cfg = settings(config)

  /** @param {any} definition */
  const register = (definition) => ctx.tools.register(definition)

  ctx.effect(() => () => {
    state.browserConn?.close()
    state.browserConn = undefined
    state.browserWsUrl = undefined
  })

  /** @param {import('../../..').ToolRunContext} exec */
  const workspaceOf = (exec) => {
    try {
      const workingDirectory = ctx.get('workingDirectory')
      const session = exec?.agent?.session
      if (workingDirectory && session) return workingDirectory.get(session)
    } catch {
      // fall through
    }
    return process.cwd()
  }

  register({
    name: 'browser_goto',
    description:
      'Open a URL in the automation browser (a real Edge window with a persistent, signed-in profile) and wait for it to load. '
      + 'This is the entry point for every browser task: call it first, then browser_read or browser_snapshot. '
      + 'The browser keeps cookies between calls, so the user only signs in once. '
      + 'If the site needs a captcha or SMS code, ask the user to complete it in the visible browser window, then continue.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL, or a bare host (https:// is added).' },
        newTab: { type: 'boolean', description: 'Open in a new tab instead of replacing the current tab. Default false.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `Loaded ${value.url}\nTitle: ${value.title || '(untitled)'}` }],
    },
    timeoutMs: 90000,
    async execute(args) {
      const raw = String(args?.url ?? '').trim()
      if (!raw) throw new Error('browser_goto needs a URL')
      const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw) ? raw : `https://${raw}`
      let url
      try {
        const parsed = new URL(candidate)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('not http(s)')
        url = parsed.href
      } catch {
        throw new Error(`Invalid URL: ${raw}`)
      }
      await ensureBrowser(cfg)
      const target = args?.newTab ? await createTarget(cfg, 'about:blank') : await currentTarget(cfg)
      state.targetId = target.id
      const { cdp } = await connectPage(cfg, target.id)
      try {
        const loaded = cdp.waitFor('Page.loadEventFired', PAGE_TIMEOUT_MS).catch(() => undefined)
        const navigation = await cdp.send('Page.navigate', { url })
        if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`)
        await loaded
        await sleep(400)
        return { ...(await pageState(cdp)), targetId: target.id }
      } finally {
        cdp.close()
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Open in automation browser', kind: 'other', rawInput: args }),
  })

  register({
    name: 'browser_read',
    description:
      'Read the visible text of the current automation-browser page, including same-origin and cross-origin iframes. '
      + 'Use it after browser_goto or a click to see what the page says. It returns text only, not interactive refs; '
      + 'use browser_snapshot when you need something to click or type into. For a visual check, use browser_screenshot.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxChars: { type: 'integer', description: 'Maximum characters to return. Default 12000, max 30000.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderPage(value) }],
    },
    timeoutMs: 60000,
    async execute(args) {
      await ensureBrowser(cfg)
      const target = await currentTarget(cfg)
      const { cdp } = await connectPage(cfg, target.id)
      try {
        const frames = await frameContexts(cdp)
        const limit = Math.min(Math.max(Number(args?.maxChars) || 12000, 1000), 30000)
        let text = ''
        let page = { title: '', url: '' }
        for (let attempt = 0; attempt < 6 && !text.trim(); attempt++) {
          if (attempt > 0) await sleep(300)
          text = ''
          for (let index = 0; index < frames.length && index < 12 && text.length < limit; index++) {
            try {
              const data = await evaluateIn(cdp, frames[index].contextId, `(() => ({
                title: document.title,
                url: location.href,
                text: (document.body
                  ? (document.body.innerText || document.body.textContent)
                  : (document.documentElement.innerText || document.documentElement.textContent)) || '',
              }))()`)
              if (index === 0) page = { title: data.title, url: data.url }
              if (data.text) {
                text += (index === 0 ? '' : `\n\n--- frame ${index}: ${data.url} ---\n`) + data.text
              }
            } catch {
              // skip frames that navigated away; the next attempt retries them
            }
          }
        }
        return { ...page, text: clip(text, limit), frameCount: frames.length }
      } finally {
        cdp.close()
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Read automation browser page', kind: 'read' }),
  })

  register({
    name: 'browser_snapshot',
    description:
      'List headings and interactive elements (links, buttons, inputs, selects, tabs) of the current page with stable refs like "f0r12". '
      + 'Run this before clicking or typing: refs are valid until the page changes, and a new snapshot replaces old refs. '
      + 'It also includes a short text excerpt and frame count; use browser_read for the full text.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderSnapshot(value) }],
    },
    timeoutMs: 60000,
    async execute() {
      await ensureBrowser(cfg)
      const target = await currentTarget(cfg)
      const { cdp } = await connectPage(cfg, target.id)
      try {
        const snapshot = await snapshotPage(cdp, target.id)
        return { ...snapshot, targetId: target.id }
      } finally {
        cdp.close()
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Snapshot automation browser page', kind: 'other' }),
  })

  register({
    name: 'browser_click',
    description:
      'Click an element in the automation browser. Pass the ref from the latest browser_snapshot (preferred), a CSS selector, '
      + 'or viewport coordinates x/y for canvas-like content that has no DOM element (read them from browser_screenshot). '
      + 'Ref clicks run through element.click() inside the correct frame, so iframe content works. '
      + 'After clicking, the new title/URL is returned; take a fresh snapshot if the page changed. '
      + 'Ask the user before actions that submit, purchase, delete, or post.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot, for example "f0r12".' },
        selector: { type: 'string', description: 'CSS selector in the main frame, used only when ref is absent.' },
        x: { type: 'number', description: 'Viewport x coordinate in CSS pixels, for a visual click.' },
        y: { type: 'number', description: 'Viewport y coordinate in CSS pixels, for a visual click.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `Clicked ${value.clicked || 'element'}.\nURL: ${value.url}\nTitle: ${value.title}` }],
    },
    timeoutMs: 60000,
    async execute(args) {
      const ref = typeof args?.ref === 'string' ? args.ref : ''
      const selector = typeof args?.selector === 'string' ? args.selector : ''
      const x = Number(args?.x)
      const y = Number(args?.y)
      const hasPoint = Number.isFinite(x) && Number.isFinite(y)
      if (!ref && !selector && !hasPoint) throw new Error('browser_click needs a ref, a selector, or x/y coordinates')
      await ensureBrowser(cfg)
      const target = await currentTarget(cfg)
      await setDownloadBehavior(cfg)
      const { cdp } = await connectPage(cfg, target.id)
      try {
        if (hasPoint) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
          await sleep(700)
          return { clicked: `viewport (${x}, ${y})`, ...(await pageState(cdp)) }
        }
        const entry = ref ? resolveRef(ref) : { contextId: await mainContextId(cdp), ref: null }
        if (entry.targetId && entry.targetId !== target.id) {
          throw new Error('That ref belongs to another tab. Switch tabs first, then run browser_snapshot.')
        }
        const expression = ref
          ? `(() => {
              const el = document.querySelector('[data-dsh-ref="${entry.ref}"]');
              if (!el) return { ok: false, error: 'element-not-found' };
              el.scrollIntoView({ block: 'center', inline: 'center' });
              el.focus({ preventScroll: true });
              el.click();
              return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 160) };
            })()`
          : `(() => {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return { ok: false, error: 'element-not-found' };
              el.scrollIntoView({ block: 'center', inline: 'center' });
              el.focus({ preventScroll: true });
              el.click();
              return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 160) };
            })()`
        let result
        try {
          result = await evaluateIn(cdp, entry.contextId, expression)
        } catch {
          throw new Error('The page changed since the snapshot. Run browser_snapshot again.')
        }
        if (!result?.ok) {
          throw new Error('Element not found. Run browser_snapshot again; the page may have changed.')
        }
        await sleep(700)
        return { clicked: `${result.tag} ${result.text || ''}`.trim(), ...(await pageState(cdp)) }
      } finally {
        cdp.close()
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Click in automation browser', kind: 'other', rawInput: args }),
  })

  register({
    name: 'browser_type',
    description:
      'Type text into an input, textarea, or contenteditable element identified by a browser_snapshot ref. '
      + 'The value is set through the native setter and input/change events, so framework-controlled forms see it. '
      + 'Set submit=true to press Enter afterwards (for search boxes and login forms).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['ref', 'text'],
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot.' },
        text: { type: 'string', description: 'Text to enter. It replaces the current value.' },
        submit: { type: 'boolean', description: 'Press Enter after typing. Default false.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `Typed into ${value.ref}${value.submitted ? ' and pressed Enter' : ''}.\nURL: ${value.url}` }],
    },
    timeoutMs: 60000,
    async execute(args) {
      const ref = String(args?.ref ?? '')
      if (!ref) throw new Error('browser_type needs a ref')
      const text = String(args?.text ?? '')
      await ensureBrowser(cfg)
      const target = await currentTarget(cfg)
      const entry = resolveRef(ref)
      if (entry.targetId && entry.targetId !== target.id) {
        throw new Error('That ref belongs to another tab. Switch tabs first, then run browser_snapshot.')
      }
      const { cdp } = await connectPage(cfg, target.id)
      try {
        const expression = `(() => {
          const el = document.querySelector('[data-dsh-ref="${entry.ref}"]');
          if (!el) return { ok: false, error: 'element-not-found' };
          el.scrollIntoView({ block: 'center', inline: 'center' });
          el.focus();
          const value = ${JSON.stringify(text)};
          if (el.isContentEditable) {
            el.textContent = value;
          } else {
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
              : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
            if (!proto) return { ok: false, error: 'not-an-input' };
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, value); else el.value = value;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, value: String(el.value ?? el.textContent ?? '').slice(0, 200) };
        })()`
        let result
        try {
          result = await evaluateIn(cdp, entry.contextId, expression)
        } catch {
          throw new Error('The page changed since the snapshot. Run browser_snapshot again.')
        }
        if (!result?.ok) throw new Error(`Could not type: ${result?.error || 'element not found'}`)
        if (args?.submit === true) {
          await cdp.send('Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r',
          })
          await cdp.send('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
          })
        }
        await sleep(600)
        return { ref, submitted: args?.submit === true, ...(await pageState(cdp)) }
      } finally {
        cdp.close()
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Type in automation browser', kind: 'other', rawInput: args }),
  })

  register({
    name: 'browser_press',
    description:
      'Press a single key in the focused element of the automation browser. Useful for Enter, Tab, Escape, arrows, PageDown, and Backspace '
      + 'after browser_click or browser_type. For text entry prefer browser_type.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['key'],
      properties: {
        key: {
          type: 'string',
          enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'],
          description: 'Key to press.',
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `Pressed ${value.key}.\nURL: ${value.url}` }],
    },
    timeoutMs: 30000,
    async execute(args) {
      const key = String(args?.key ?? '')
      const map = {
        Enter: { code: 'Enter', vk: 13, text: '\r' },
        Tab: { code: 'Tab', vk: 9 },
        Escape: { code: 'Escape', vk: 27 },
        Backspace: { code: 'Backspace', vk: 8 },
        ArrowUp: { code: 'ArrowUp', vk: 38 },
        ArrowDown: { code: 'ArrowDown', vk: 40 },
        ArrowLeft: { code: 'ArrowLeft', vk: 37 },
        ArrowRight: { code: 'ArrowRight', vk: 39 },
        PageUp: { code: 'PageUp', vk: 33 },
        PageDown: { code: 'PageDown', vk: 34 },
        Home: { code: 'Home', vk: 36 },
        End: { code: 'End', vk: 35 },
        Space: { code: 'Space', vk: 32, text: ' ' },
      }
      const info = map[key]
      if (!info) throw new Error(`Unsupported key: ${key}`)
      await ensureBrowser(cfg)
      const target = await currentTarget(cfg)
      const { cdp } = await connectPage(cfg, target.id)
      try {
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key, code: info.code, windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk,
          ...(info.text ? { text: info.text, unmodifiedText: info.text } : {}),
        })
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key, code: info.code, windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk,
        })
        await sleep(300)
        return { key, ...(await pageState(cdp)) }
      } finally {
        cdp.close()
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Press key in automation browser', kind: 'other', rawInput: args }),
  })

  register({
    name: 'browser_scroll',
    description:
      'Scroll the current automation-browser page with a mouse wheel event at the viewport center, which also scrolls nested iframes and lazy-loaded lists.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deltaY: { type: 'integer', description: 'Vertical wheel delta in pixels. Positive scrolls down. Default 700.' },
        deltaX: { type: 'integer', description: 'Horizontal wheel delta. Default 0.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `Scrolled to y=${value.scrollY} of ${value.scrollHeight}.` }],
    },
    timeoutMs: 30000,
    async execute(args) {
      await ensureBrowser(cfg)
      const target = await currentTarget(cfg)
      const { cdp } = await connectPage(cfg, target.id)
      try {
        const viewport = await evaluateIn(cdp, await mainContextId(cdp), '({ width: window.innerWidth, height: window.innerHeight })')
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Math.round((viewport?.width || 800) / 2),
          y: Math.round((viewport?.height || 600) / 2),
          deltaX: Number(args?.deltaX) || 0,
          deltaY: Number(args?.deltaY) || 700,
        })
        await sleep(500)
        const position = await evaluateIn(cdp, await mainContextId(cdp), `({
          scrollY: Math.round(window.scrollY),
          scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
        })`)
        return position
      } finally {
        cdp.close()
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Scroll automation browser', kind: 'other' }),
  })

  register({
    name: 'browser_screenshot',
    description:
      'Capture a PNG of the automation browser page (viewport by default, or the full page) and save it in the workspace under .dsh-browser/screenshots. '
      + 'The returned path can be opened with read_image to see the page exactly as rendered, including canvases and captcha images.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fullPage: { type: 'boolean', description: 'Capture the entire scroll height instead of the viewport. Default false.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{
        type: 'text',
        text: `Screenshot saved: ${value.path} (${value.width || '?'}x${value.height || '?'}, ${value.bytes} bytes)`,
      }],
    },
    timeoutMs: 60000,
    async execute(args, exec) {
      await ensureBrowser(cfg)
      const target = await currentTarget(cfg)
      const { cdp } = await connectPage(cfg, target.id)
      try {
        let clip
        if (args?.fullPage === true) {
          const metrics = await cdp.send('Page.getLayoutMetrics')
          const size = metrics.cssContentSize || metrics.contentSize
          clip = {
            x: 0,
            y: 0,
            width: Math.max(1, Math.min(Math.ceil(size.width), 4000)),
            height: Math.max(1, Math.min(Math.ceil(size.height), 16000)),
            scale: 1,
          }
        }
        const capture = () => cdp.send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: args?.fullPage === true,
          ...(clip ? { clip } : {}),
        }, 30000)
        let shot
        try {
          shot = await capture()
        } catch {
          // A hidden or backgrounded tab can stall the compositor; bring it forward and retry once.
          await cdp.send('Page.bringToFront').catch(() => undefined)
          await sleep(400)
          shot = await capture()
        }
        const directory = join(workspaceOf(exec), '.dsh-browser', 'screenshots')
        await mkdir(directory, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const path = join(directory, `shot-${stamp}.png`)
        const buffer = Buffer.from(shot.data, 'base64')
        await writeFile(path, buffer)
        const viewport = await evaluateIn(cdp, await mainContextId(cdp), '({ width: window.innerWidth, height: window.innerHeight })')
        return { path, bytes: buffer.length, width: viewport?.width, height: viewport?.height, targetId: target.id }
      } finally {
        cdp.close()
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Screenshot automation browser', kind: 'other' }),
  })

  register({
    name: 'browser_tabs',
    description:
      'Manage automation-browser tabs: list them, switch the active tab, close a tab, or open a new one. '
      + 'Use list first to get exact target ids. The active tab is the one every other browser_* tool drives.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'switch', 'close', 'new'], description: 'Operation to perform.' },
        targetId: { type: 'string', description: 'Tab id for switch or close.' },
        url: { type: 'string', description: 'URL for action=new. Default about:blank.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{
        type: 'text',
        text: value.tabs.map((tab) => `${tab.active ? '*' : ' '} ${tab.id} | ${tab.title || '(untitled)'} | ${tab.url}`).join('\n'),
      }],
    },
    timeoutMs: 60000,
    async execute(args) {
      await ensureBrowser(cfg)
      const action = String(args?.action ?? 'list')
      if (action === 'new') {
        let url = 'about:blank'
        if (typeof args?.url === 'string' && args.url.trim()) {
          const raw = args.url.trim()
          const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw) ? raw : `https://${raw}`
          url = new URL(candidate).href
        }
        const created = await createTarget(cfg, url)
        state.targetId = created.id
      } else if (action === 'switch' || action === 'close') {
        const targetId = String(args?.targetId ?? '')
        if (!targetId) throw new Error(`browser_tabs ${action} needs targetId`)
        const pages = await pageTargets(cfg)
        if (!pages.some((page) => page.id === targetId)) throw new Error(`Unknown tab id: ${targetId}`)
        if (action === 'switch') {
          const { cdp } = await connectPage(cfg, targetId)
          try {
            await cdp.send('Page.bringToFront')
          } finally {
            cdp.close()
          }
          state.targetId = targetId
        } else {
          await withBrowser(cfg, (browser) => browser.send('Target.closeTarget', { targetId }))
          if (state.targetId === targetId) state.targetId = undefined
        }
      } else if (action !== 'list') {
        throw new Error(`Unknown action: ${action}`)
      }
      const pages = await pageTargets(cfg)
      if (!state.targetId && pages.length > 0) state.targetId = pages[pages.length - 1].id
      return {
        tabs: pages.map((page) => ({
          id: page.id,
          title: page.title,
          url: page.url,
          active: page.id === state.targetId,
        })),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Manage automation browser tabs', kind: 'other', rawInput: args }),
  })

  register({
    name: 'browser_upload',
    description:
      'Attach local files to a file input in the automation browser. The ref must point at an <input type="file"> from browser_snapshot. '
      + 'Paths are absolute host paths. The page receives a normal change event, as if the user picked the files.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['ref', 'files'],
      properties: {
        ref: { type: 'string', description: 'Ref of the file input from browser_snapshot.' },
        files: {
          type: 'array',
          description: 'Absolute paths to upload.',
          items: { type: 'string' },
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `Attached ${value.files.length} file(s) to ${value.ref}.` }],
    },
    timeoutMs: 60000,
    async execute(args) {
      const ref = String(args?.ref ?? '')
      const files = Array.isArray(args?.files) ? args.files.map(String) : []
      if (!ref) throw new Error('browser_upload needs a ref')
      if (files.length === 0) throw new Error('browser_upload needs at least one file')
      for (const file of files) {
        if (!existsSync(file)) throw new Error(`File does not exist: ${file}`)
      }
      await ensureBrowser(cfg)
      const target = await currentTarget(cfg)
      const entry = resolveRef(ref)
      if (entry.targetId && entry.targetId !== target.id) {
        throw new Error('That ref belongs to another tab. Switch tabs first, then run browser_snapshot.')
      }
      const { cdp } = await connectPage(cfg, target.id)
      try {
        let object
        try {
          object = await cdp.send('Runtime.evaluate', {
            expression: `document.querySelector('[data-dsh-ref="${entry.ref}"]')`,
            contextId: entry.contextId,
            returnByValue: false,
          })
        } catch {
          throw new Error('The page changed since the snapshot. Run browser_snapshot again.')
        }
        const objectId = object.result?.objectId
        if (!objectId) throw new Error('File input not found. Run browser_snapshot again.')
        // setFileInputFiles accepts the RemoteObject id directly, which avoids a stale
        // nodeId when the document or a frame changed between calls.
        await cdp.send('DOM.setFileInputFiles', { objectId, files })
        return { ref, files }
      } finally {
        cdp.close()
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Upload files in automation browser', kind: 'other', rawInput: args }),
  })

  register({
    name: 'browser_download',
    description:
      'Download a URL with the automation browser, so the request carries the signed-in cookies, and save it to the automation download folder. '
      + 'Poll for the completed file (partial .crdownload files are ignored). Without a URL it only configures the download folder and lists existing files. '
      + 'For a download triggered by a button, call browser_click first with the folder already configured.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to download. Omit to just list the download folder.' },
        timeoutMs: { type: 'integer', description: 'How long to wait for the file. Default 60000.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{
        type: 'text',
        text: value.files?.length
          ? `Downloaded:\n${value.files.join('\n')}`
          : `No download completed. Folder: ${value.directory}\n${value.message || ''}`,
      }],
    },
    timeoutMs: 120000,
    async execute(args) {
      await ensureBrowser(cfg)
      const started = Date.now()
      const rawUrl = typeof args?.url === 'string' ? args.url.trim() : ''
      if (!rawUrl) {
        await setDownloadBehavior(cfg)
        let existing = []
        try {
          existing = (await readdir(cfg.downloadDir, { withFileTypes: true }))
            .filter((entry) => entry.isFile())
            .map((entry) => join(cfg.downloadDir, entry.name))
        } catch {
          // an empty or missing folder is fine
        }
        return {
          files: existing,
          directory: cfg.downloadDir,
          message: 'Download folder configured. Pass a URL or click a download link next.',
        }
      }
      const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(rawUrl) ? rawUrl : `https://${rawUrl}`
      const url = new URL(candidate).href
      const created = await createTarget(cfg, 'about:blank')
      state.targetId = created.id
      await setDownloadBehavior(cfg)
      const page = await connectPage(cfg, created.id)
      try {
        await page.cdp.send('Page.navigate', { url })
      } finally {
        page.cdp.close()
      }
      const timeout = Math.min(Math.max(Number(args?.timeoutMs) || 60000, 5000), 110000)
      const sizes = new Map()
      const stable = new Map()
      while (Date.now() - started < timeout) {
        await sleep(500)
        let entries = []
        try {
          entries = await readdir(cfg.downloadDir, { withFileTypes: true })
        } catch {
          continue
        }
        const completed = []
        for (const entry of entries) {
          if (!entry.isFile()) continue
          if (entry.name.endsWith('.crdownload') || entry.name.endsWith('.tmp')) continue
          const path = join(cfg.downloadDir, entry.name)
          try {
            const info = await stat(path)
            if (info.mtimeMs < started - 2000) continue
            const previous = sizes.get(path)
            sizes.set(path, info.size)
            const count = previous === info.size ? (stable.get(path) || 0) + 1 : 0
            stable.set(path, count)
            if (count >= 2) completed.push(path)
          } catch {
            // file vanished between listing and stat
          }
        }
        if (completed.length > 0) {
          return { files: completed, directory: cfg.downloadDir, message: '' }
        }
      }
      return {
        files: [],
        directory: cfg.downloadDir,
        message: 'The URL may have opened a page rather than started a download.',
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Download in automation browser', kind: 'fetch', rawInput: args }),
  })
}
