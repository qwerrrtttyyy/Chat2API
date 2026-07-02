/**
 * Web Admin Panel Routes for Termux Headless
 * Serves the management web page and provides OAuth endpoints.
 * Existing management API routes (CRUD for accounts, providers, config, proxy)
 * are handled by the main project's management routes.
 */

import Router from '@koa/router'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { storeManager } from './file-store.js'
import { headlessOAuth } from './headless-oauth.js'
import { autoOAuthManager } from './auto-oauth.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Read admin HTML
const adminHtmlPath = resolve(__dirname, 'admin.html')
let adminHtml = ''
try {
  adminHtml = readFileSync(adminHtmlPath, 'utf-8')
} catch {
  console.warn('[WebAdmin] admin.html not found at:', adminHtmlPath)
}

export function setupWebAdminRoutes(): Router {
  const router = new Router()

  // ==================== Admin Page ====================

  // Serve admin panel
  router.get('/admin', async (ctx) => {
    ctx.type = 'text/html; charset=utf-8'
    ctx.body = adminHtml
  })

  router.get('/admin.html', async (ctx) => {
    ctx.type = 'text/html; charset=utf-8'
    ctx.body = adminHtml
  })

  // ==================== OAuth Endpoints ====================

  // Get login URL for a provider
  router.get('/v0/management/oauth/:providerId/login-url', async (ctx) => {
    const { providerId } = ctx.params
    try {
      const result = await headlessOAuth.startOAuth(providerId)
      ctx.body = {
        success: true,
        data: {
          providerId,
          loginPageUrl: result.loginPageUrl,
          callbackPort: headlessOAuth.getCallbackPort(),
          message: result.message,
        },
      }
    } catch (error: any) {
      ctx.status = 400
      ctx.body = { success: false, error: { message: error.message } }
    }
  })

  // Validate a token for a provider
  router.post('/v0/management/accounts/validate-token', async (ctx) => {
    const { providerId, credentials } = ctx.request.body as {
      providerId: string
      credentials: Record<string, string>
    }
    if (!providerId || !credentials) {
      ctx.status = 400
      ctx.body = { success: false, error: { message: 'providerId and credentials are required' } }
      return
    }
    const result = await headlessOAuth.validateToken(providerId, credentials)
    ctx.body = { success: true, data: result }
  })

  // Get supported OAuth providers
  router.get('/v0/management/oauth/providers', async (ctx) => {
    const providers = storeManager.getProviders()
    const oauthProviders = providers
      .filter(p => {
        const config = headlessOAuth.getProviderConfig(p.id)
        return config !== null
      })
      .map(p => ({
        id: p.id,
        name: p.name,
        loginPageUrl: headlessOAuth.getLoginUrl(p.id),
        authType: p.authType,
      }))
    ctx.body = { success: true, data: oauthProviders }
  })

  // ==================== Auto OAuth Endpoints ====================

  // Check if auto OAuth (Playwright) is available
  router.get('/v0/management/oauth/auto/available', async (ctx) => {
    ctx.body = {
      success: true,
      data: {
        available: autoOAuthManager.isAvailable(),
        message: autoOAuthManager.isAvailable()
          ? 'Playwright is available for automated OAuth'
          : 'Playwright not installed. Run: npm install playwright && npx playwright install chromium',
      },
    }
  })

  // Start auto OAuth for a provider
  router.post('/v0/management/oauth/:providerId/auto/start', async (ctx) => {
    const { providerId } = ctx.params
    const body = ctx.request.body as { credentials?: Record<string, string> } || {}

    try {
      const result = await autoOAuthManager.startForProvider(providerId, body.credentials)
      if (!result.sessionId) {
        ctx.status = 400
        ctx.body = { success: false, error: { message: result.message } }
        return
      }
      ctx.body = {
        success: true,
        data: {
          sessionId: result.sessionId,
          providerId,
          message: result.message,
        },
      }
    } catch (error: any) {
      ctx.status = 500
      ctx.body = { success: false, error: { message: error.message } }
    }
  })

  // Poll auto OAuth progress
  router.get('/v0/management/oauth/auto/:sessionId/status', async (ctx) => {
    const { sessionId } = ctx.params
    const progress = autoOAuthManager.getProgress(sessionId)
    if (!progress) {
      ctx.status = 404
      ctx.body = { success: false, error: { message: 'Session not found' } }
      return
    }
    ctx.body = { success: true, data: progress }
  })

  // Cancel auto OAuth session
  router.post('/v0/management/oauth/auto/:sessionId/cancel', async (ctx) => {
    const { sessionId } = ctx.params
    const cancelled = autoOAuthManager.cancelSession(sessionId)
    ctx.body = { success: cancelled, data: { cancelled } }
  })

  return router
}