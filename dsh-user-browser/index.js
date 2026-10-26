/**
 * dsh-user-browser
 *
 * Host-side tool plugin that drives the user's own default browser: open pages in new
 * tabs and run web searches without leaving the conversation. It never starts its own
 * automation profile, so whatever the user is already signed in to stays available.
 *
 * Page content is deliberately not read here. The model reads pages with `web_fetch`;
 * this plugin only makes the user's screen show the right thing.
 *
 * @module dsh-user-browser
 */
import { spawn } from 'node:child_process'

/** Provider name claimed in the shared browser-use service, when that seam exists. */
const PROVIDER_NAME = 'user-browser'

/** Search engines offered by `browser_search`. */
const SEARCH_ENGINES = {
  bing: { label: 'Bing', url: 'https://www.bing.com/search?q=' },
  baidu: { label: '百度', url: 'https://www.baidu.com/s?wd=' },
  google: { label: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  sogou: { label: '搜狗', url: 'https://www.sogou.com/web?query=' },
}

const ENGINE_NAMES = Object.keys(SEARCH_ENGINES)
const DEFAULT_ENGINE = 'bing'
const MAX_URLS = 10

export const name = 'user-browser'
export const inject = ['tools']

/**
 * Turn user/model input into an absolute http(s) URL. Bare hosts get an https scheme,
 * anything else (`file:`, `javascript:`, ...) is refused.
 *
 * @param {unknown} input raw URL text.
 * @returns {string} normalized absolute URL.
 */
function normalizeUrl(input) {
  const raw = String(input ?? '').trim()
  if (raw.length === 0) throw new Error('URL must be a non-empty string')
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw) ? raw : `https://${raw}`
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`Invalid URL: ${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http and https URLs can be opened (got ${parsed.protocol})`)
  }
  return parsed.href
}

/**
 * Hand one URL to the OS default-browser handler without a console window and without
 * blocking the Host. On Windows `rundll32 url.dll,FileProtocolHandler` respects the
 * user's default-browser choice, so Edge/Chrome/Firefox all work.
 *
 * @param {string} url absolute URL.
 * @param {string} browserPath optional executable override.
 * @returns {Promise<void>} resolves once the launcher process has spawned.
 */
function openInBrowser(url, browserPath) {
  return new Promise((resolve, reject) => {
    let command
    let args
    if (browserPath) {
      command = browserPath
      args = [url]
    } else if (process.platform === 'win32') {
      command = 'rundll32.exe'
      args = ['url.dll,FileProtocolHandler', url]
    } else if (process.platform === 'darwin') {
      command = 'open'
      args = [url]
    } else {
      command = 'xdg-open'
      args = [url]
    }
    let child
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * Open several URLs, spacing them slightly apart so the browser creates one tab per
 * URL instead of coalescing rapid launches.
 *
 * @param {string[]} urls normalized URLs.
 * @param {string} browserPath optional executable override.
 * @returns {Promise<void>} resolves when every launch was handed off.
 */
async function openUrls(urls, browserPath) {
  for (let index = 0; index < urls.length; index++) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 180))
    await openInBrowser(urls[index], browserPath)
  }
}

/**
 * Resolve the configured default search engine.
 *
 * @param {Record<string, unknown>} config row config.
 * @returns {string} a key of {@link SEARCH_ENGINES}.
 */
function resolveDefaultEngine(config) {
  const requested = config.defaultEngine ?? config.searchEngine
  return typeof requested === 'string' && requested in SEARCH_ENGINES ? requested : DEFAULT_ENGINE
}

/**
 * Register the browser tools on `ctx.tools`.
 *
 * @param {import('cordis').Context} ctx plugin context.
 * @param {{ browserPath?: string, defaultEngine?: string, searchEngine?: string }} [config] row config.
 */
export function apply(ctx, config = {}) {
  const browserPath = typeof config.browserPath === 'string' ? config.browserPath : ''
  const fallbackEngine = resolveDefaultEngine(config)

  // Claim the shared browser-use slot when this profile exposes it. A second provider
  // failing to register is not fatal: the tools below work on their own.
  const browserUse = ctx.get('browserUse')
  if (browserUse) {
    try {
      const release = browserUse.register(PROVIDER_NAME)
      ctx.effect(() => () => {
        void release()
      })
    } catch {
      // Another browser-use provider owns the slot; keep our tools available.
    }
  }

  ctx.tools.register({
    name: 'browser_open',
    description:
      'Open one or more web pages in the user\'s own default browser as new tabs, so the user can see them. '
      + 'Use this when the user asks to open a site, or when showing a page is more useful than reading it. '
      + 'This does not return page content: use web_fetch for the text of a page and web_search for research. '
      + `Accepts 1-${MAX_URLS} absolute http(s) URLs (a bare host becomes https://).`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['urls'],
      properties: {
        urls: {
          type: 'array',
          description: `Pages to open, one new tab each (1-${MAX_URLS}).`,
          items: { type: 'string', description: 'An http(s) URL, for example https://example.com' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['opened', 'count'],
        properties: {
          opened: { type: 'array', items: { type: 'string' }, description: 'URLs handed to the browser.' },
          count: { type: 'integer', description: 'Number of tabs requested.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.count === 1
          ? `Opened ${value.opened[0]} in your default browser.`
          : `Opened ${value.count} tabs in your default browser:\n${value.opened.join('\n')}`,
      }],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const raw = Array.isArray(args?.urls) ? args.urls : []
      if (raw.length === 0) throw new Error('browser_open needs at least one URL')
      if (raw.length > MAX_URLS) throw new Error(`browser_open accepts at most ${MAX_URLS} URLs`)
      const opened = raw.map(normalizeUrl)
      await openUrls(opened, browserPath)
      return { opened, count: opened.length }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: Array.isArray(args?.urls) && args.urls.length > 1 ? 'Open pages in browser' : 'Open page in browser',
      kind: 'other',
      rawInput: args,
    }),
  })

  ctx.tools.register({
    name: 'browser_search',
    description:
      'Run a web search in the user\'s own default browser: opens a new tab with the results for the query. '
      + 'Use it when the user wants to see search results themselves. To read results as data instead, use web_search. '
      + `Engines: ${ENGINE_NAMES.join(', ')} (default ${fallbackEngine}).`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'What to search for. Natural-language queries are fine.',
        },
        engine: {
          type: 'string',
          enum: ENGINE_NAMES,
          description: `Search engine to use. Defaults to ${fallbackEngine}.`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'engine', 'url'],
        properties: {
          query: { type: 'string', description: 'The query that was searched.' },
          engine: { type: 'string', description: 'Engine key that was used.' },
          url: { type: 'string', description: 'Search-results URL opened in the browser.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Searched "${value.query}" on ${SEARCH_ENGINES[value.engine]?.label ?? value.engine} in your default browser:\n${value.url}`,
      }],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = String(args?.query ?? '').trim()
      if (query.length === 0) throw new Error('browser_search needs a non-empty query')
      const engine = typeof args?.engine === 'string' && args.engine in SEARCH_ENGINES
        ? args.engine
        : fallbackEngine
      const url = SEARCH_ENGINES[engine].url + encodeURIComponent(query)
      await openInBrowser(url, browserPath)
      return { query, engine, url }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Search in browser',
      kind: 'other',
      rawInput: args,
    }),
  })
}
