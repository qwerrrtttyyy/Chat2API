/**
 * Chat2API Termux Headless Edition
 * Entry point for running the proxy server on Termux (Android)
 * Includes web-based management panel and OAuth support.
 * 
 * Usage: node --import tsx --import ./termux/src/loader.ts ./termux/src/index.ts
 */

import { storeManager } from './file-store.js'
import { setupWebAdminRoutes } from './web-admin.js'
import { headlessOAuth } from './headless-oauth.js'

// Helper: print colored output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
}

function printBanner(): void {
  console.log(`${colors.cyan}${colors.bold}`)
  console.log('  ╔══════════════════════════════════════════╗')
  console.log('  ║       Chat2API Termux Headless v1.4.0     ║')
  console.log('  ║   OpenAI-compatible API Proxy for Mobile  ║')
  console.log('  ╚══════════════════════════════════════════╝')
  console.log(`${colors.reset}`)
}

function ensureManagementApiEnabled(): { secret: string; isNew: boolean } {
  const config = storeManager.getConfig()
  const mgmtConfig = config.managementApi
  const currentSecret = mgmtConfig?.managementApiSecret || ''

  // If management API is disabled or has no secret, auto-enable with a default
  if (!mgmtConfig?.enableManagementApi || !currentSecret) {
    const secret = 'admin'
    console.log(`${colors.yellow}[Termux] Auto-enabling management API with default secret: ${secret}${colors.reset}`)
    // Directly update via setConfig to ensure nested managementApi is written
    const updatedConfig = {
      ...config,
      managementApi: {
        enableManagementApi: true,
        managementApiSecret: secret,
      },
    }
    storeManager.setConfig(updatedConfig)
    return { secret, isNew: true }
  }

  return { secret: currentSecret, isNew: false }
}

async function main(): Promise<void> {
  printBanner()

  // Initialize the file-based store
  console.log(`[Termux] Initializing storage...`)
  try {
    await storeManager.initialize()
    console.log(`${colors.green}[Termux] Storage initialized at: ${storeManager.getStorePath()}${colors.reset}`)
  } catch (error) {
    console.error(`${colors.red}[Termux] Failed to initialize storage:`, error, colors.reset)
    process.exit(1)
  }

  // Ensure management API is enabled for web admin panel
  const { secret, isNew } = ensureManagementApiEnabled()

  // Load config
  const config = storeManager.getConfig()
  const port = parseInt(process.env.PORT || '') || config.proxyPort || 8080
  const host = process.env.HOST || config.proxyHost || '0.0.0.0'

  // Print account summary
  const accounts = storeManager.getAccounts(true)
  const providers = storeManager.getProviders()
  console.log(`[Termux] Providers: ${providers.length}, Accounts: ${accounts.length}`)
  if (accounts.length > 0) {
    console.log(`[Termux] Active accounts:`)
    for (const account of accounts) {
      const provider = providers.find((p: any) => p.id === account.providerId)
      console.log(`  - ${provider?.name || account.providerId}: ${account.name} [${account.status}]`)
    }
  }

  // Start OAuth callback server
  try {
    await headlessOAuth.startOAuth('deepseek').catch(() => {})
    console.log(`${colors.green}[Termux] OAuth callback server ready on port ${headlessOAuth.getCallbackPort()}${colors.reset}`)
  } catch {
    // OAuth callback server is optional
  }

  // Import and start proxy server
  console.log(`[Termux] Starting proxy server on ${host}:${port}...`)

  try {
    // The loader hooks will redirect store imports to our file-store
    const { proxyServer } = await import('../../src/main/proxy/server.js')

    // Register web admin routes BEFORE the catch-all 404 handler
    // The server.ts constructor registers a catch-all at the end of the middleware chain.
    // We need to insert our routes before it.
    const webAdminRouter = setupWebAdminRoutes()
    const catchAll = proxyServer.app.middleware.pop() // Remove catch-all
    proxyServer.app.use(webAdminRouter.routes())
    proxyServer.app.use(webAdminRouter.allowedMethods())
    if (catchAll) proxyServer.app.use(catchAll) // Restore catch-all
    console.log('[Termux] Web admin panel registered at /admin')

    const started = await proxyServer.start(port, host)

    if (started) {
      console.log(`${colors.green}${colors.bold}`)
      console.log(`  Proxy server is running!`)
      console.log(`  API endpoint:  http://${host}:${port}/v1/chat/completions`)
      console.log(`  Health check:  http://${host}:${port}/health`)
      console.log(`  Admin panel:   http://${host}:${port}/admin`)
      console.log(`${colors.reset}`)

      if (isNew) {
        console.log(`${colors.yellow}  Management API enabled with default secret: ${secret}${colors.reset}`)
        console.log(`${colors.yellow}  Change it in the admin panel Settings tab.${colors.reset}`)
      }

      if (config.enableApiKey && config.apiKeys && config.apiKeys.length > 0) {
        console.log(`${colors.yellow}  API Key authentication is enabled (${config.apiKeys.length} keys)${colors.reset}`)
      }

      if (accounts.length === 0) {
        console.log(`${colors.cyan}`)
        console.log(`  No accounts configured yet.`)
        console.log(`  Open http://${host}:${port}/admin to add accounts.`)
        console.log(`${colors.reset}`)
      }
    } else {
      console.error(`${colors.red}[Termux] Failed to start proxy server${colors.reset}`)
      process.exit(1)
    }
  } catch (error) {
    console.error(`${colors.red}[Termux] Failed to start proxy server:`, error, colors.reset)
    process.exit(1)
  }

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[Termux] Received ${signal}, shutting down...`)
    try {
      headlessOAuth.stop()
      const { proxyServer } = await import('../../src/main/proxy/server.js')
      await proxyServer.stop()
      storeManager.flushPendingWrites()
      console.log(`[Termux] Shutdown complete.`)
      process.exit(0)
    } catch (error) {
      console.error(`[Termux] Error during shutdown:`, error)
      process.exit(1)
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGHUP', () => shutdown('SIGHUP'))

  // Keep the process alive
  process.stdin.resume()
}

main().catch((error) => {
  console.error(`${colors.red}[Termux] Fatal error:`, error, colors.reset)
  process.exit(1)
})