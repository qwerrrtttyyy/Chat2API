/**
 * Headless OAuth Handler for Termux
 * Provides OAuth login flow without Electron BrowserWindow.
 * Uses a local callback server to capture OAuth redirects.
 */

import http from 'http'
import crypto from 'crypto'
import { URL } from 'url'
import axios from 'axios'
import { storeManager } from './file-store.js'

interface OAuthSession {
  providerId: string
  providerType: string
  state: string
  createdAt: number
  resolved: boolean
  resolve?: (result: OAuthHeadlessResult) => void
  reject?: (error: Error) => void
}

interface OAuthHeadlessResult {
  success: boolean
  providerId: string
  providerType: string
  credentials?: Record<string, string>
  accountInfo?: {
    userId?: string
    email?: string
    name?: string
    avatar?: string
  }
  error?: string
}

interface CreateAccountRequest {
  providerId: string
  name: string
  email?: string
  credentials: Record<string, string>
  dailyLimit?: number
}

// Provider-specific OAuth URL generators
const OAUTH_CONFIGS: Record<string, {
  authUrl: string
  loginPageUrl: string
  tokenValidationUrl: string
  tokenValidationMethod: 'GET' | 'POST'
  credentialField: string
  authType: string
  extractAccountInfo: (data: any) => { userId?: string; email?: string; name?: string }
}> = {
  deepseek: {
    authUrl: '',
    loginPageUrl: 'https://chat.deepseek.com',
    tokenValidationUrl: 'https://chat.deepseek.com/api/v0/users/current',
    tokenValidationMethod: 'GET',
    credentialField: 'token',
    authType: 'userToken',
    extractAccountInfo: (data: any) => {
      const bizData = data?.data?.biz_data
      return bizData ? { userId: bizData.id, email: bizData.email, name: bizData.name } : {}
    },
  },
  glm: {
    authUrl: '',
    loginPageUrl: 'https://chatglm.cn',
    tokenValidationUrl: 'https://chatglm.cn/api/userinfo',
    tokenValidationMethod: 'GET',
    credentialField: 'refresh_token',
    authType: 'refresh_token',
    extractAccountInfo: (data: any) => {
      return data ? { userId: data.id, email: data.email, name: data.username } : {}
    },
  },
  kimi: {
    authUrl: '',
    loginPageUrl: 'https://www.kimi.com',
    tokenValidationUrl: 'https://kimi.moonshot.cn/api/user',
    tokenValidationMethod: 'GET',
    credentialField: 'token',
    authType: 'jwt',
    extractAccountInfo: (data: any) => {
      return data ? { userId: data.id, email: data.email, name: data.name } : {}
    },
  },
  minimax: {
    authUrl: '',
    loginPageUrl: 'https://agent.minimaxi.com',
    tokenValidationUrl: 'https://agent.minimaxi.com/api/user/info',
    tokenValidationMethod: 'GET',
    credentialField: 'token',
    authType: 'token',
    extractAccountInfo: (data: any) => {
      return data ? { userId: data.id, email: data.email, name: data.name } : {}
    },
  },
  qwen: {
    authUrl: '',
    loginPageUrl: 'https://www.qianwen.com',
    tokenValidationUrl: '',
    tokenValidationMethod: 'GET',
    credentialField: 'token',
    authType: 'cookie',
    extractAccountInfo: () => ({}),
  },
  perplexity: {
    authUrl: '',
    loginPageUrl: 'https://www.perplexity.ai',
    tokenValidationUrl: '',
    tokenValidationMethod: 'GET',
    credentialField: 'sessionToken',
    authType: 'cookie',
    extractAccountInfo: () => ({}),
  },
}

// Headers for API validation requests
const FAKE_HEADERS: Record<string, Record<string, string>> = {
  deepseek: {
    'Accept': '*/*',
    'Origin': 'https://chat.deepseek.com',
    'Referer': 'https://chat.deepseek.com/',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'X-Client-Platform': 'web',
    'X-Client-Version': '1.6.1',
  },
  kimi: {
    'Accept': '*/*',
    'Origin': 'https://www.kimi.com',
    'Referer': 'https://www.kimi.com/',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36',
  },
  glm: {
    'Accept': '*/*',
    'Origin': 'https://chatglm.cn',
    'Referer': 'https://chatglm.cn/',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36',
  },
  minimax: {
    'Accept': '*/*',
    'Origin': 'https://agent.minimaxi.com',
    'Referer': 'https://agent.minimaxi.com/',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36',
  },
}

class HeadlessOAuthManager {
  private sessions: Map<string, OAuthSession> = new Map()
  private callbackServer: http.Server | null = null
  private callbackPort: number = 8311

  /**
   * Get the login page URL for a provider
   */
  getLoginUrl(providerId: string): string {
    const config = OAUTH_CONFIGS[providerId]
    return config?.loginPageUrl || ''
  }

  /**
   * Get provider OAuth config
   */
  getProviderConfig(providerId: string) {
    return OAUTH_CONFIGS[providerId] || null
  }

  /**
   * Start OAuth flow - returns a URL for the user to open
   */
  async startOAuth(providerId: string): Promise<{
    sessionId: string
    authUrl: string
    loginPageUrl: string
    message: string
  }> {
    const config = OAUTH_CONFIGS[providerId]
    if (!config) {
      throw new Error(`Provider "${providerId}" does not support OAuth`)
    }

    const state = crypto.randomBytes(16).toString('hex')
    const sessionId = crypto.randomUUID()

    this.sessions.set(sessionId, {
      providerId,
      providerType: providerId,
      state,
      createdAt: Date.now(),
      resolved: false,
    })

    // Start callback server if not running
    await this.ensureCallbackServer()

    const loginPageUrl = config.loginPageUrl
    const message = `请在浏览器中打开以下链接登录 ${providerId}:\n\n${loginPageUrl}\n\n登录后获取 Token 并输入到管理页面。`

    return {
      sessionId,
      authUrl: loginPageUrl,
      loginPageUrl,
      message,
    }
  }

  /**
   * Validate a token for a provider
   */
  async validateToken(providerId: string, credentials: Record<string, string>): Promise<{
    valid: boolean
    accountInfo?: { userId?: string; email?: string; name?: string }
    error?: string
  }> {
    const config = OAUTH_CONFIGS[providerId]
    if (!config) {
      // For unknown providers, just return valid (trust the user)
      return { valid: true }
    }

    if (!config.tokenValidationUrl) {
      return { valid: true }
    }

    const token = credentials[config.credentialField] || credentials.token || ''
    if (!token) {
      return { valid: false, error: 'Token is empty' }
    }

    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(FAKE_HEADERS[providerId] || {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36',
        }),
      }

      const response = await axios({
        method: config.tokenValidationMethod,
        url: config.tokenValidationUrl,
        headers,
        timeout: 15000,
        validateStatus: () => true,
      })

      if (response.status === 200) {
        const accountInfo = config.extractAccountInfo(response.data)
        return { valid: true, accountInfo }
      }

      if (response.status === 401 || response.status === 403) {
        return { valid: false, error: 'Token is invalid or expired' }
      }

      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Validation failed' }
    }
  }

  /**
   * Create an account with validated credentials
   */
  createAccount(data: {
    providerId: string
    name: string
    email?: string
    credentials: Record<string, string>
  }) {
    const provider = storeManager.getProviderById(data.providerId)
    if (!provider) {
      storeManager.ensureProviderExists(data.providerId)
    }

    const now = Date.now()
    const account = {
      id: storeManager.generateId(),
      providerId: data.providerId,
      name: data.name,
      email: data.email,
      credentials: data.credentials,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
      requestCount: 0,
      todayUsed: 0,
      lastStatusCheck: now,
      lastUsed: now,
    }

    storeManager.addAccount(account)
    return account
  }

  /**
   * Start the callback server
   */
  private async ensureCallbackServer(): Promise<void> {
    if (this.callbackServer) return

    return new Promise((resolve, reject) => {
      this.callbackServer = http.createServer((req, res) => {
        this.handleCallback(req, res)
      })

      this.callbackServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          this.callbackPort++
          this.callbackServer?.listen(this.callbackPort)
        } else {
          console.error('[HeadlessOAuth] Callback server error:', err)
        }
      })

      this.callbackServer.listen(this.callbackPort, '0.0.0.0', () => {
        console.log(`[HeadlessOAuth] Callback server on port ${this.callbackPort}`)
        resolve()
      })
    })
  }

  /**
   * Handle OAuth callback
   */
  private handleCallback(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${this.callbackPort}`)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const token = url.searchParams.get('token')
    const error = url.searchParams.get('error')

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<html><body><h2>授权失败</h2><p>${error}</p><p>请关闭此页面。</p></body></html>`)
      return
    }

    // Find session by state
    let session: OAuthSession | undefined
    if (state) {
      for (const s of this.sessions.values()) {
        if (s.state === state && !s.resolved) {
          session = s
          break
        }
      }
    }

    if (code || token) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<html><body><h2>授权成功！</h2><p>已获取授权凭证，请关闭此页面并返回管理页面完成配置。</p></body></html>`)

      if (session && session.resolve) {
        session.resolved = true
        session.resolve({
          success: true,
          providerId: session.providerId,
          providerType: session.providerType,
          credentials: token ? { token } : { code: code! },
        })
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<html><body><h2>Chat2API Termux</h2><p>OAuth 回调服务器正在运行。</p><p>端口: ${this.callbackPort}</p></body></html>`)
    }
  }

  /**
   * Get callback port
   */
  getCallbackPort(): number {
    return this.callbackPort
  }

  /**
   * Stop the callback server
   */
  stop(): void {
    if (this.callbackServer) {
      this.callbackServer.close()
      this.callbackServer = null
    }
    this.sessions.clear()
  }
}

export const headlessOAuth = new HeadlessOAuthManager()
export default headlessOAuth