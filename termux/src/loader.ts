/**
 * Termux Module Loader
 * Intercepts imports of Electron-dependent store module and redirects to file-based store.
 * Must be loaded via --import flag BEFORE the main entry point.
 *
 * Usage: node --import tsx --import ./termux/src/loader.ts ./termux/src/index.ts
 */

import { register } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

register('./store-resolver.ts', { parentURL: import.meta.url, data: { __dirname } })