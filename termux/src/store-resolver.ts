/**
 * Store Resolver Hook
 * Redirects imports of Electron-dependent modules to Termux-compatible versions.
 * Called by the Node.js module loader hook chain.
 *
 * IMPORTANT: Does NOT use shortCircuit so that tsx can still transform TypeScript files.
 * Instead, calls nextResolve with the replacement URL.
 */

import type { ResolveHook, LoadHook } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// The file-store module URL
const FILE_STORE_URL = new URL('./file-store.ts', import.meta.url).href

// The electron shim URL
const ELECTRON_SHIM_URL = new URL('./electron-shim.ts', import.meta.url).href

// The perplexity adapter URL
const PERPLEXITY_SHIM_URL = new URL('./perplexity-shim.ts', import.meta.url).href

export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  // Redirect store imports to our file-based store
  if (specifier.endsWith('/store/store') || specifier.endsWith('/store/store.ts') || specifier.endsWith('/store/store.js')) {
    console.log('[Termux Loader] Redirecting store import:', specifier, '-> file-store.ts')
    return nextResolve(FILE_STORE_URL, context)
  }

  // Redirect electron imports to our shim
  if (specifier === 'electron') {
    console.log('[Termux Loader] Redirecting electron import -> electron-shim.ts')
    return nextResolve(ELECTRON_SHIM_URL, context)
  }

  // Redirect perplexity adapter to axios-based version
  if (specifier.includes('/adapters/perplexity') && !specifier.includes('perplexity-shim')) {
    if (specifier.endsWith('/perplexity') || specifier.endsWith('/perplexity.ts') || specifier.endsWith('/perplexity.js')) {
      console.log('[Termux Loader] Redirecting perplexity adapter -> perplexity-shim.ts')
      return nextResolve(PERPLEXITY_SHIM_URL, context)
    }
  }

  // Use default resolution for everything else (tsx will handle TypeScript transformation)
  return nextResolve(specifier, context)
}

export const load: LoadHook = async (url, context, nextLoad) => {
  return nextLoad(url, context)
}