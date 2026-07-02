/**
 * Chat2API Termux Headless Edition
 * Entry point for running the proxy server on Termux (Android)
 * 
 * Usage: node --import tsx --import ./termux/src/loader.ts ./termux/src/index.ts
 */

import { storeManager } from './file-store.js'

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
      const provider = providers.find(p => p.id === account.providerId)
      console.log(`  - ${provider?.name || account.providerId}: ${account.name} [${account.status}]`)
    }
  } else {
    console.log(`${colors.yellow}[Termux] No accounts configured.`)
    console.log(`[Termux] Configure accounts in: ${storeManager.getStorePath()}/data.json`)
    console.log(`[Termux] Or use the desktop version to set up accounts, then copy data.json to Termux.${colors.reset}`)
  }

  // Import and start proxy server
  console.log(`[Termux] Starting proxy server on ${host}:${port}...`)

  try {
    // The loader hooks will redirect store imports to our file-store,
    // so we can import the proxy server code directly
    const { proxyServer } = await import('../../src/main/proxy/server.js')

    const started = await proxyServer.start(port, host)

    if (started) {
      console.log(`${colors.green}${colors.bold}`)
      console.log(`  Proxy server is running!`)
      console.log(`  Listening on: http://${host}:${port}`)
      console.log(`  API endpoint: http://${host}:${port}/v1/chat/completions`)
      console.log(`  Health check: http://${host}:${port}/health`)
      console.log(`${colors.reset}`)

      if (config.enableApiKey && config.apiKeys && config.apiKeys.length > 0) {
        console.log(`${colors.yellow}  API Key authentication is enabled (${config.apiKeys.length} keys)${colors.reset}`)
      } else {
        console.log(`${colors.yellow}  API Key authentication is disabled${colors.reset}`)
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