/**
 * Termux CJS Preload Script
 * Monkey-patches Module._resolveFilename to redirect Electron-dependent modules.
 * This handles CJS require() calls that tsx generates from TypeScript compilation.
 * 
 * Usage: node --require ./termux/src/preload.cjs --import tsx --import ./termux/src/loader.ts ./termux/src/index.ts
 */

const Module = require('node:module')
const path = require('node:path')

const originalResolveFilename = Module._resolveFilename

// Path to our replacement modules
const TERMUX_SRC = path.resolve(__dirname) // __dirname = termux/src/
const FILE_STORE_PATH = path.join(TERMUX_SRC, 'file-store.ts')
const ELECTRON_SHIM_PATH = path.join(TERMUX_SRC, 'electron-shim.ts')
const PERPLEXITY_SHIM_PATH = path.join(TERMUX_SRC, 'perplexity-shim.ts')

Module._resolveFilename = function (request, parent, isMain, options) {
  // Redirect store imports to our file-based store
  // Handles various relative paths: ../store/store, ../../store/store, ./store, ../store
  if (request.endsWith('/store/store') || request.endsWith('/store/store.ts') || request.endsWith('/store/store.js') ||
      request.endsWith('/store') || request.endsWith('/store.ts') || request.endsWith('/store.js')) {
    console.log('[Termux CJS] Redirecting store import:', request, '-> file-store.ts')
    return FILE_STORE_PATH
  }

  // Redirect electron imports to our shim
  if (request === 'electron') {
    console.log('[Termux CJS] Redirecting electron import -> electron-shim.ts')
    return ELECTRON_SHIM_PATH
  }

  // Redirect perplexity adapter to axios-based version
  if (request.includes('/adapters/perplexity') && !request.includes('perplexity-shim')) {
    if (request.endsWith('/perplexity') || request.endsWith('/perplexity.ts') || request.endsWith('/perplexity.js')) {
      console.log('[Termux CJS] Redirecting perplexity adapter -> perplexity-shim.ts')
      return PERPLEXITY_SHIM_PATH
    }
  }

  return originalResolveFilename.call(this, request, parent, isMain, options)
}