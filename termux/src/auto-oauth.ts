/**
 * Automatic OAuth Token Extraction using Playwright
 * Replicates the Electron app's BrowserWindow token interception
 * using a headless browser.
 *
 * Supports two modes:
 * 1. Headless auto-fill: Uses saved credentials to auto-login
 * 2. Headless wait: Opens login page, waits for user to complete login
 *    (via URL provided to open on phone browser - requires CDP connect)
 *
 * Dependencies (optional): playwright
 *   npm install playwright
 *   npx playwright install chromium
 *
 * Falls back to manual token input if Playwright is not available.
 */

import { EventEmitter } from 'events'

interface AutoOAuthOptions {
  providerId: string
  providerType: string
  loginUrl: string
  tokenSources: TokenSource[]
  targetDomains: string[]
  successUrlPatterns?: string[]
  timeout?: number
  credentials?: Record<string, string> // email/password for auto-fill
  executablePath?: string // custom Chromium path
  cdpEndpoint?: string // connect to existing browser
}

interface TokenSource {
  type: 'networkHeader' | 'localStorage' | 'cookie'
  key: string
  urlPattern?: string
  extractPattern?: string
}

interface AutoOAuthResult {
  success: boolean
  credentials?: Record<string, string>
  accountInfo?: { userId?: string; email?: string; name?: string }
  error?: string
}

interface AutoOAuthProgress {
  status: 'starting' | 'navigating' | 'waiting_login' | 'extracting' | 'complete' | 'error'
  message: string
  screenshot?: string // base64 screenshot for progress display
}

// Try to import Playwright
let playwright: any = null
let hasPlaywright = false

// Check synchronously via createRequire (works in both ESM and CJS via tsx)
try {
  const { createRequire } = await import('module')
  const _require = createRequire(import.meta.url)
  _require.resolve('playwright')
  hasPlaywright = true
} catch {
  hasPlaywright = false
}

// ============================================================
// Provider-specific token extraction configs (from Electron app)
// ============================================================

export interface ProviderAutoOAuthConfig {
  loginUrl: string
  tokenSources: TokenSource[]
  targetDomains: string[]
  successUrlPatterns?: RegExp[]
}

export const PROVIDER_AUTO_OAUTH_CONFIGS: Record<string, ProviderAutoOAuthConfig> = {
  deepseek: {
    loginUrl: 'https://chat.deepseek.com',
    tokenSources: [{ type: 'localStorage', key: 'userToken' }],
    targetDomains: ['.deepseek.com', 'deepseek.com'],
    successUrlPatterns: [/chat\.deepseek\.com/i],
  },
  kimi: {
    loginUrl: 'https://www.kimi.com',
    tokenSources: [
      { type: 'networkHeader', key: 'token', urlPattern: '*://*.kimi.com/*', extractPattern: '^Bearer\\s+(.+)$' },
    ],
    targetDomains: ['.kimi.com', 'kimi.com'],
    successUrlPatterns: [/kimi\.com/i],
  },
  glm: {
    loginUrl: 'https://chatglm.cn',
    tokenSources: [{ type: 'cookie', key: 'chatglm_refresh_token' }],
    targetDomains: ['.chatglm.cn', 'chatglm.cn'],
    successUrlPatterns: [/chatglm\.cn/i],
  },
  minimax: {
    loginUrl: 'https://agent.minimaxi.com',
    tokenSources: [
      { type: 'localStorage', key: '_token' },
      { type: 'localStorage', key: 'user_detail_agent' },
    ],
    targetDomains: ['.minimaxi.com', 'minimaxi.com'],
    successUrlPatterns: [/agent\.minimaxi\.com/i],
  },
  qwen: {
    loginUrl: 'https://www.qianwen.com',
    tokenSources: [{ type: 'cookie', key: 'tongyi_sso_ticket' }],
    targetDomains: ['.qianwen.com', 'qianwen.com'],
    successUrlPatterns: [/qianwen\.com/i],
  },
  perplexity: {
    loginUrl: 'https://www.perplexity.ai',
    tokenSources: [
      { type: 'cookie', key: '__Secure-next-auth.session-token' },
      { type: 'cookie', key: 'next-auth.session-token' },
    ],
    targetDomains: ['.perplexity.ai', 'perplexity.ai'],
    successUrlPatterns: [/perplexity\.ai/i],
  },
}

export class AutoOAuthManager extends EventEmitter {
  private activeSessions: Map<string, {
    browser: any
    context: any
    page: any
    foundTokens: Map<string, string>
    allCookies: Record<string, string>
    isCompleted: boolean
    timeoutId: NodeJS.Timeout | null
    startTime: number
    progress: AutoOAuthProgress
  }> = new Map()

  /**
   * Check if Playwright is available
   */
  isAvailable(): boolean {
    return hasPlaywright
  }

  /**
   * Get provider auto OAuth config
   */
  getProviderConfig(providerId: string): ProviderAutoOAuthConfig | null {
    return PROVIDER_AUTO_OAUTH_CONFIGS[providerId] || null
  }

  /**
   * Convenience: Start auto OAuth for a known provider
   */
  async startForProvider(providerId: string, credentials?: Record<string, string>): Promise<{
    sessionId: string
    message: string
  }> {
    const config = PROVIDER_AUTO_OAUTH_CONFIGS[providerId]
    if (!config) {
      return { sessionId: '', message: `Provider "${providerId}" does not support auto OAuth` }
    }
    return this.startAutoOAuth({
      providerId,
      providerType: providerId,
      loginUrl: config.loginUrl,
      tokenSources: config.tokenSources,
      targetDomains: config.targetDomains,
      successUrlPatterns: config.successUrlPatterns?.map(r => r.source),
      credentials,
    })
  }

  /**
   * Start automatic OAuth flow
   */
  async startAutoOAuth(options: AutoOAuthOptions): Promise<{
    sessionId: string
    message: string
  }> {
    if (!hasPlaywright || !playwright) {
      // Try to load dynamically
      try {
        playwright = await import('playwright')
        hasPlaywright = true
      } catch {
        return {
          sessionId: '',
          message: 'Playwright is not installed. Run: npm install playwright && npx playwright install chromium',
        }
      }
    }

    const sessionId = `auto-oauth-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`

    // Start the flow in the background
    this.runAutoOAuth(sessionId, options).catch((error) => {
      console.error(`[AutoOAuth] Error in session ${sessionId}:`, error)
      this.emitProgress(sessionId, {
        status: 'error',
        message: error.message || 'Unknown error',
      })
    })

    return {
      sessionId,
      message: 'Auto OAuth started. Poll /v0/management/oauth/auto/${sessionId}/status for progress.',
    }
  }

  /**
   * Get progress of an auto OAuth session
   */
  getProgress(sessionId: string): {
    status: string
    message: string
    credentials?: Record<string, string>
    accountInfo?: any
    error?: string
  } | null {
    const session = this.activeSessions.get(sessionId)
    if (!session) return null

    const result: any = {
      status: session.progress?.status || 'running',
      message: session.progress?.message || 'OAuth flow in progress...',
    }

    if (session.isCompleted) {
      if (session.progress?.status === 'error') {
        result.status = 'error'
        result.error = session.progress.message
        return result
      }

      const credentials: Record<string, string> = {}
      session.foundTokens.forEach((value, key) => {
        if (key === 'allCookies') {
          try {
            const parsed = JSON.parse(value)
            Object.assign(credentials, parsed)
          } catch {}
        } else {
          credentials[key] = value
        }
      })

      result.status = 'complete'
      result.message = 'Token extraction complete'
      result.credentials = Object.keys(credentials).length > 0 ? credentials : undefined
    }

    return result
  }

  /**
   * Cancel an auto OAuth session
   */
  cancelSession(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId)
    if (!session) return false

    session.isCompleted = true
    if (session.timeoutId) clearTimeout(session.timeoutId)

    try {
      session.browser?.close().catch(() => {})
    } catch {}

    this.activeSessions.delete(sessionId)
    return true
  }

  /**
   * Internal: Run the auto OAuth flow
   */
  private async runAutoOAuth(sessionId: string, options: AutoOAuthOptions): Promise<void> {
    const { chromium } = playwright
    let browser: any = null
    let context: any = null
    let page: any = null

    const foundTokens = new Map<string, string>()
    const allCookies: Record<string, string> = {}
    let isCompleted = false

    const launchOptions: any = {
      headless: true,
      channel: 'chromium', // Use full Chromium, not headless shell
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
      ],
    }

    if (options.executablePath) {
      launchOptions.executablePath = options.executablePath
    }

    // Store session early so it's available for polling even if browser fails
    const session: any = {
      browser: null, context: null, page: null,
      foundTokens, allCookies, isCompleted: false,
      timeoutId: null,
      startTime: Date.now(),
      progress: { status: 'starting' as const, message: 'Launching browser...' },
    }
    this.activeSessions.set(sessionId, session)

    try {
      this.emitProgress(sessionId, { status: 'starting', message: 'Launching browser...' })

      // Launch or connect
      if (options.cdpEndpoint) {
        browser = await chromium.connectOverCDP(options.cdpEndpoint)
      } else {
        browser = await chromium.launch(launchOptions)
      }
      session.browser = browser

      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        viewport: { width: 412, height: 915 },
      })
      session.context = context

      page = await context.newPage()
      session.page = page

      // Set timeout
      const timeout = options.timeout || 300000
      session.timeoutId = setTimeout(() => {
        session.isCompleted = true
        this.emitProgress(sessionId, {
          status: 'error',
          message: 'Login timeout',
        })
        browser.close().catch(() => {})
      }, timeout)

      // Setup token interception
      this.setupTokenInterception(page, options, foundTokens, allCookies, sessionId)

      // Navigate to login page
      this.emitProgress(sessionId, { status: 'navigating', message: `Opening ${options.loginUrl}...` })

      await page.goto(options.loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      })

      this.emitProgress(sessionId, {
        status: 'waiting_login',
        message: 'Waiting for login... Please complete login in the browser.',
      })

      // If credentials provided, try auto-fill
      if (options.credentials) {
        await this.tryAutoFill(page, options, sessionId)
      }

      // Wait for success URL patterns or token detection
      await this.waitForSuccess(page, options, foundTokens, allCookies, sessionId, session)

      // Extract tokens from localStorage and cookies
      await this.extractTokens(page, context, options, foundTokens, allCookies, sessionId)

      // Mark as completed
      session.isCompleted = true
      if (session.timeoutId) clearTimeout(session.timeoutId)

      const credentials: Record<string, string> = {}
      foundTokens.forEach((value, key) => {
        if (key !== 'allCookies') {
          credentials[key] = value
        }
      })

      this.emitProgress(sessionId, {
        status: 'complete',
        message: `Extracted ${Object.keys(credentials).length} tokens`,
      })

      // Close browser after a short delay
      setTimeout(() => {
        browser.close().catch(() => {})
        this.activeSessions.delete(sessionId)
      }, 5000)

    } catch (error: any) {
      // Keep session alive with error so users can poll and see the error
      isCompleted = true
      session.isCompleted = true
      if (session.timeoutId) clearTimeout(session.timeoutId)
      this.emitProgress(sessionId, {
        status: 'error',
        message: error.message || 'Auto OAuth failed',
      })
      try { browser?.close() } catch {}
      // Keep session for 60s so users can read the error, then clean up
      setTimeout(() => {
        this.activeSessions.delete(sessionId)
      }, 60000)
    }
  }

  /**
   * Setup network interception for token extraction
   */
  private setupTokenInterception(
    page: any,
    options: AutoOAuthOptions,
    foundTokens: Map<string, string>,
    allCookies: Record<string, string>,
    sessionId: string
  ): void {
    // Intercept network requests to capture Authorization headers
    page.on('request', (request: any) => {
      const headers = request.headers()
      const authHeader = headers['authorization'] || headers['Authorization']

      if (authHeader) {
        for (const source of options.tokenSources) {
          if (source.type === 'networkHeader') {
            let token = authHeader
            if (source.extractPattern) {
              const match = authHeader.match(new RegExp(source.extractPattern))
              if (match && match[1]) {
                token = match[1]
              }
            } else if (authHeader.startsWith('Bearer ')) {
              token = authHeader.substring(7)
            }

            if (token && this.isValidToken(token)) {
              console.log(`[AutoOAuth] Found token from network header: ${source.key}`)
              foundTokens.set(source.key, token)
            }
          }
        }
      }
    })

    // Intercept response headers to capture Set-Cookie
    page.on('response', (response: any) => {
      const setCookieHeaders = response.headers()['set-cookie']
      if (setCookieHeaders) {
        const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders]
        for (const cookieHeader of cookies) {
          const nameValue = cookieHeader.split(';')[0]?.trim()
          if (nameValue) {
            const [name, ...valueParts] = nameValue.split('=')
            const value = valueParts.join('=')
            allCookies[name] = value

            for (const source of options.tokenSources) {
              if (source.type === 'cookie' && name === source.key) {
                if (this.isValidToken(value)) {
                  console.log(`[AutoOAuth] Found token from Set-Cookie: ${source.key}`)
                  foundTokens.set(source.key, value)
                }
              }
            }
          }
        }
      }
    })
  }

  /**
   * Try to auto-fill login form with provided credentials
   */
  private async tryAutoFill(
    page: any,
    options: AutoOAuthOptions,
    sessionId: string
  ): Promise<void> {
    const creds = options.credentials!
    if (!creds.email && !creds.username && !creds.phone) return

    try {
      await page.waitForTimeout(3000) // Wait for page to fully load

      this.emitProgress(sessionId, {
        status: 'waiting_login',
        message: 'Auto-filling login form...',
      })

      // Try common email/username selectors
      const emailSelectors = [
        'input[type="email"]',
        'input[name="email"]',
        'input[name="username"]',
        'input[placeholder*="email" i]',
        'input[placeholder*="邮箱" i]',
        'input[placeholder*="手机" i]',
        'input[placeholder*="phone" i]',
        'input[id*="email" i]',
        'input[id*="username" i]',
        'input[id*="phone" i]',
      ]

      const emailValue = creds.email || creds.username || creds.phone || ''
      for (const selector of emailSelectors) {
        const input = await page.$(selector)
        if (input) {
          await input.fill(emailValue)
          console.log(`[AutoOAuth] Filled email field: ${selector}`)
          break
        }
      }

      // Try common password selectors
      if (creds.password) {
        const passwordSelectors = [
          'input[type="password"]',
          'input[name="password"]',
          'input[placeholder*="password" i]',
          'input[placeholder*="密码" i]',
          'input[id*="password" i]',
        ]

        for (const selector of passwordSelectors) {
          const input = await page.$(selector)
          if (input) {
            await input.fill(creds.password)
            console.log(`[AutoOAuth] Filled password field: ${selector}`)
            break
          }
        }
      }

      // Try to click submit button
      const submitSelectors = [
        'button[type="submit"]',
        'button[class*="login" i]',
        'button[class*="submit" i]',
        'button:has-text("Login")',
        'button:has-text("登录")',
        'button:has-text("Sign in")',
        'button:has-text("Sign In")',
        '[role="button"]:has-text("Login")',
      ]

      for (const selector of submitSelectors) {
        const button = await page.$(selector)
        if (button) {
          await button.click()
          console.log(`[AutoOAuth] Clicked submit button: ${selector}`)
          break
        }
      }

      this.emitProgress(sessionId, {
        status: 'waiting_login',
        message: 'Login form submitted, waiting for redirect...',
      })
    } catch (error) {
      console.log('[AutoOAuth] Auto-fill failed, continuing with manual login...')
    }
  }

  /**
   * Wait for login success
   */
  private async waitForSuccess(
    page: any,
    options: AutoOAuthOptions,
    foundTokens: Map<string, string>,
    allCookies: Record<string, string>,
    sessionId: string,
    session: any
  ): Promise<void> {
    const successPatterns = options.successUrlPatterns || []

    // Check every 3 seconds
    const maxWait = options.timeout || 300000
    const startTime = Date.now()

    while (Date.now() - startTime < maxWait) {
      if (session.isCompleted) return

      // Check if we've found tokens
      if (foundTokens.size > 0) {
        console.log(`[AutoOAuth] Tokens found during wait: ${Array.from(foundTokens.keys()).join(', ')}`)
        return
      }

      // Check URL for success patterns
      try {
        const currentUrl = page.url()
        for (const pattern of successPatterns) {
          if (new RegExp(pattern).test(currentUrl)) {
            console.log(`[AutoOAuth] Success URL matched: ${currentUrl}`)
            // Wait a bit for tokens to be stored
            await page.waitForTimeout(3000)
            return
          }
        }
      } catch {}

      await page.waitForTimeout(3000)
    }
  }

  /**
   * Extract tokens from localStorage and cookies
   */
  private async extractTokens(
    page: any,
    context: any,
    options: AutoOAuthOptions,
    foundTokens: Map<string, string>,
    allCookies: Record<string, string>,
    sessionId: string
  ): Promise<void> {
    this.emitProgress(sessionId, { status: 'extracting', message: 'Extracting tokens...' })

    // Extract from localStorage
    try {
      for (const source of options.tokenSources) {
        if (source.type === 'localStorage') {
          try {
            const value = await page.evaluate((key: string) => {
              return localStorage.getItem(key)
            }, source.key)

            if (value) {
              console.log(`[AutoOAuth] Found localStorage token: ${source.key}`)

              // Handle special case for user_detail_agent (MiniMax)
              if (source.key === 'user_detail_agent') {
                try {
                  const parsed = JSON.parse(value)
                  if (parsed.realUserID || parsed.id) {
                    foundTokens.set('realUserID', String(parsed.realUserID || parsed.id))
                  }
                } catch {}
                continue
              }

              // Handle JSON-wrapped tokens
              let tokenValue = value
              if (value.startsWith('{') && value.endsWith('}')) {
                try {
                  const parsed = JSON.parse(value)
                  if (parsed.value) tokenValue = parsed.value
                } catch {}
              }

              if (this.isValidToken(tokenValue)) {
                foundTokens.set(source.key, tokenValue)
              }
            }
          } catch (e) {
            console.log(`[AutoOAuth] Error reading localStorage key ${source.key}:`, e)
          }
        }
      }
    } catch (e) {
      console.log('[AutoOAuth] Error accessing localStorage:', e)
    }

    // Extract from cookies
    try {
      const cookies = await context.cookies()
      for (const cookie of cookies) {
        allCookies[cookie.name] = cookie.value

        for (const source of options.tokenSources) {
          if (source.type === 'cookie' && cookie.name === source.key) {
            if (cookie.value && this.isValidToken(cookie.value)) {
              console.log(`[AutoOAuth] Found cookie token: ${source.key}`)
              foundTokens.set(source.key, cookie.value)
            }
          }
        }
      }

      // Store all cookies as a combined credential
      if (Object.keys(allCookies).length > 0) {
        foundTokens.set('allCookies', JSON.stringify(allCookies))
      }
    } catch (e) {
      console.log('[AutoOAuth] Error reading cookies:', e)
    }
  }

  /**
   * Validate if a string looks like a valid token
   * Same logic as the Electron app's isValidToken
   */
  private isValidToken(value: string): boolean {
    if (!value || value.length < 5) return false

    // JWT/JWE format
    if (value.startsWith('eyJ')) {
      const parts = value.split('.')
      if (parts.length === 5) return value.length >= 100 // JWE
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
          if (payload.email && payload.email.includes('@guest.com')) return false
          if (payload && (payload.app_id || payload.sub || payload.exp || payload.id || payload.user_id)) return true
        } catch {
          return false
        }
      }
    }

    // Long tokens (>= 64 chars)
    if (value.length >= 64 && /^[a-zA-Z0-9_\-+/*]+$/.test(value)) return true

    // Medium tokens (32-63 chars)
    if (value.length >= 32 && value.length < 64 && /^[a-zA-Z0-9_\-+/*]+$/.test(value)) return true

    // Base64 tokens
    if (value.length >= 20 && /^[a-zA-Z0-9_\-+/]+=*$/.test(value)) return true

    // Generic tokens (>= 5 chars, no spaces)
    if (value.length >= 5 && !/\s/.test(value)) return true

    return false
  }

  /**
   * Emit progress event
   */
  private emitProgress(sessionId: string, progress: AutoOAuthProgress): void {
    const session = this.activeSessions.get(sessionId)
    if (session) session.progress = progress
    this.emit('progress', { sessionId, ...progress })
    console.log(`[AutoOAuth] ${progress.status}: ${progress.message}`)
  }
}

export const autoOAuthManager = new AutoOAuthManager()
export default autoOAuthManager