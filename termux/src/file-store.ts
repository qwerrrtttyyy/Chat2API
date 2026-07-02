/**
 * Termux File Store Module
 * Lightweight JSON file-based storage replacing electron-store for Termux headless mode
 * Data stored in ~/.chat2api/ (compatible with desktop version)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type {
  StoreSchema,
  AppConfig,
  Account,
  Provider,
  LogEntry,
  LogLevel,
  SessionRecord,
  SessionConfig,
  ChatMessage,
  RequestLogEntry,
  PersistentStatistics,
  DailyStatistics,
  SystemPrompt,
  EffectiveModel,
  CustomModel,
  ProviderModelOverrides,
  UserModelOverrides,
  ModelMapping,
} from '../../src/main/store/types'
import {
  DEFAULT_CONFIG,
  BUILTIN_PROVIDERS,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_STATISTICS,
  DEFAULT_USER_MODEL_OVERRIDES,
  DEFAULT_REQUEST_LOG_CONFIG,
  createDefaultModelMappings,
  normalizeModelMappingsWithDefaults,
  sanitizeDeepSeekModelOverrides,
} from '../../src/main/store/types'
import { BUILTIN_PROMPTS } from '../../src/main/data/builtin-prompts'
import { normalizeRequestLogConfig } from '../../src/main/requestLogs/types'
import { normalizeToolCallingConfig } from '../../src/shared/toolCalling'

// Simple in-memory log manager for termux
class InMemoryLogManager {
  private logs: LogEntry[] = []
  private maxEntries: number = 7000

  setMaxEntries(max: number): void { this.maxEntries = max }

  async initialize(): Promise<void> {}
  async migrateLegacyLogs(legacy: LogEntry[]): Promise<void> {
    this.logs.push(...legacy)
  }

  addLog(entry: LogEntry): void {
    this.logs.push(entry)
    if (this.logs.length > this.maxEntries) {
      this.logs = this.logs.slice(-this.maxEntries)
    }
  }

  getLogs(filter?: { level?: LogLevel; limit?: number; offset?: number }): LogEntry[] {
    let result = [...this.logs]
    if (filter?.level) {
      result = result.filter(l => l.level === filter.level)
    }
    result.sort((a, b) => b.timestamp - a.timestamp)
    if (filter?.limit) {
      result = result.slice(filter.offset || 0, (filter.offset || 0) + filter.limit)
    }
    return result
  }

  clearLogs(): void { this.logs = [] }
  replaceLogs(logs: LogEntry[]): void { this.logs = logs }

  exportLogs(): LogEntry[] { return [...this.logs] }

  getStats(): { total: number; info: number; warn: number; error: number; debug: number } {
    return {
      total: this.logs.length,
      info: this.logs.filter(l => l.level === 'info').length,
      warn: this.logs.filter(l => l.level === 'warn').length,
      error: this.logs.filter(l => l.level === 'error').length,
      debug: this.logs.filter(l => l.level === 'debug').length,
    }
  }

  getTrend(days: number = 7): { date: string; total: number; info: number; warn: number; error: number }[] {
    const trend: Record<string, { total: number; info: number; warn: number; error: number }> = {}
    const now = Date.now()
    for (const log of this.logs) {
      if (log.timestamp > now - days * 86400000) {
        const date = new Date(log.timestamp).toISOString().split('T')[0]
        if (!trend[date]) trend[date] = { total: 0, info: 0, warn: 0, error: 0 }
        trend[date].total++
        if (log.level === 'info') trend[date].info++
        else if (log.level === 'warn') trend[date].warn++
        else if (log.level === 'error') trend[date].error++
      }
    }
    return Object.entries(trend).map(([date, stats]) => ({ date, ...stats }))
  }

  getAccountTrend(accountId: string, days: number = 7): { date: string; total: number; info: number; warn: number; error: number }[] {
    const trend: Record<string, { total: number; info: number; warn: number; error: number }> = {}
    const now = Date.now()
    for (const log of this.logs) {
      if (log.accountId === accountId && log.timestamp > now - days * 86400000) {
        const date = new Date(log.timestamp).toISOString().split('T')[0]
        if (!trend[date]) trend[date] = { total: 0, info: 0, warn: 0, error: 0 }
        trend[date].total++
        if (log.level === 'info') trend[date].info++
        else if (log.level === 'warn') trend[date].warn++
        else if (log.level === 'error') trend[date].error++
      }
    }
    return Object.entries(trend).map(([date, stats]) => ({ date, ...stats }))
  }

  flushSync(): void {}
}

// Simple in-memory request log manager
class InMemoryRequestLogManager {
  private logs: RequestLogEntry[] = []
  private config: { enabled: boolean; maxEntries: number; includeBodies: boolean; maxBodyChars: number; redactSensitiveData: boolean } = DEFAULT_REQUEST_LOG_CONFIG

  setConfig(cfg: typeof this.config): void { this.config = cfg }

  async initialize(): Promise<void> {}
  async migrateLegacyLogs(legacy: RequestLogEntry[]): Promise<void> {
    this.logs.push(...legacy)
  }

  addRequestLog(entry: Omit<RequestLogEntry, 'id'>): RequestLogEntry {
    const newEntry: RequestLogEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
    }
    if (this.config.enabled) {
      this.logs.push(newEntry)
      if (this.logs.length > this.config.maxEntries) {
        this.logs = this.logs.slice(-this.config.maxEntries)
      }
    }
    return newEntry
  }

  updateRequestLog(id: string, updates: Partial<RequestLogEntry>): boolean {
    const index = this.logs.findIndex(l => l.id === id)
    if (index === -1) return false
    this.logs[index] = { ...this.logs[index], ...updates }
    return true
  }

  getRequestLogs(limit?: number, filter?: { status?: 'success' | 'error'; providerId?: string }): RequestLogEntry[] {
    let result = [...this.logs]
    if (filter?.status) result = result.filter(l => l.status === filter.status)
    if (filter?.providerId) result = result.filter(l => l.providerId === filter.providerId)
    result.sort((a, b) => b.timestamp - a.timestamp)
    if (limit) result = result.slice(0, limit)
    return result
  }

  getRequestLogById(id: string): RequestLogEntry | undefined {
    return this.logs.find(l => l.id === id)
  }

  clearRequestLogs(): void { this.logs = [] }
  exportRequestLogs(): RequestLogEntry[] { return [...this.logs] }

  getRequestLogStats(): { total: number; success: number; error: number; todayTotal: number; todaySuccess: number; todayError: number } {
    const today = new Date().toISOString().split('T')[0]
    const todayLogs = this.logs.filter(l => new Date(l.timestamp).toISOString().split('T')[0] === today)
    return {
      total: this.logs.length,
      success: this.logs.filter(l => l.status === 'success').length,
      error: this.logs.filter(l => l.status === 'error').length,
      todayTotal: todayLogs.length,
      todaySuccess: todayLogs.filter(l => l.status === 'success').length,
      todayError: todayLogs.filter(l => l.status === 'error').length,
    }
  }

  getRequestLogTrend(days: number = 7): { date: string; total: number; success: number; error: number; avgLatency: number }[] {
    const trend: Record<string, { total: number; success: number; error: number; totalLatency: number }> = {}
    const now = Date.now()
    for (const log of this.logs) {
      if (log.timestamp > now - days * 86400000) {
        const date = new Date(log.timestamp).toISOString().split('T')[0]
        if (!trend[date]) trend[date] = { total: 0, success: 0, error: 0, totalLatency: 0 }
        trend[date].total++
        if (log.status === 'success') { trend[date].success++; trend[date].totalLatency += log.latency }
        else trend[date].error++
      }
    }
    return Object.entries(trend).map(([date, stats]) => ({
      date,
      total: stats.total,
      success: stats.success,
      error: stats.error,
      avgLatency: stats.success > 0 ? Math.round(stats.totalLatency / stats.success) : 0,
    }))
  }

  flushSync(): void {}
}

class FileStoreManager {
  private data: StoreSchema | null = null
  private isInitialized: boolean = false
  private storagePath: string
  private dataFilePath: string
  private appLogManager: InMemoryLogManager
  private requestLogManager: InMemoryRequestLogManager
  private initializationError: Error | null = null

  constructor() {
    this.storagePath = join(homedir(), '.chat2api')
    this.dataFilePath = join(this.storagePath, 'data.json')
    this.appLogManager = new InMemoryLogManager()
    this.requestLogManager = new InMemoryRequestLogManager()
  }

  hasInitializationError(): boolean {
    return this.initializationError !== null
  }

  getInitializationError(): Error | null {
    return this.initializationError
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return

    try {
      // Ensure storage directory exists
      if (!existsSync(this.storagePath)) {
        mkdirSync(this.storagePath, { recursive: true })
      }

      // Load or create data file
      if (existsSync(this.dataFilePath)) {
        try {
          const raw = readFileSync(this.dataFilePath, 'utf-8')
          this.data = JSON.parse(raw)
          // Ensure all required fields exist
          this.data = {
            providers: this.data?.providers || [],
            accounts: this.data?.accounts || [],
            config: this.data?.config || DEFAULT_CONFIG,
            logs: this.data?.logs || [],
            requestLogs: this.data?.requestLogs || [],
            systemPrompts: this.data?.systemPrompts || [],
            sessions: this.data?.sessions || [],
            statistics: this.data?.statistics || DEFAULT_STATISTICS,
            userModelOverrides: this.data?.userModelOverrides || DEFAULT_USER_MODEL_OVERRIDES,
          }
        } catch {
          console.log('[FileStore] Corrupted data file, creating new one')
          this.data = this.getDefaultData()
          this.saveData()
        }
      } else {
        this.data = this.getDefaultData()
        this.saveData()
      }

      // Initialize log managers
      await this.appLogManager.initialize()
      const legacyLogs = this.data.logs || []
      if (legacyLogs.length > 0) {
        await this.appLogManager.migrateLegacyLogs(legacyLogs)
        this.data.logs = []
      }

      await this.requestLogManager.initialize()
      const legacyRequestLogs = this.data.requestLogs || []
      if (legacyRequestLogs.length > 0) {
        await this.requestLogManager.migrateLegacyLogs(legacyRequestLogs)
        this.data.requestLogs = []
      }

      // Normalize config
      this.data.config = this.normalizeConfig(this.data.config)
      this.initializeDefaultModelMappings()
      await this.initializeDefaultProviders()

      this.isInitialized = true
      this.initializationError = null
      console.log('[FileStore] Initialized successfully, path:', this.storagePath)
    } catch (error) {
      this.initializationError = error instanceof Error ? error : new Error(String(error))
      console.error('[FileStore] Failed to initialize:', error)
      throw error
    }
  }

  private getDefaultData(): StoreSchema {
    return {
      providers: [],
      accounts: [],
      config: DEFAULT_CONFIG,
      logs: [],
      requestLogs: [],
      systemPrompts: [],
      sessions: [],
      statistics: DEFAULT_STATISTICS,
      userModelOverrides: DEFAULT_USER_MODEL_OVERRIDES,
    }
  }

  private saveData(): void {
    if (!this.data) return
    const toSave = {
      ...this.data,
      config: this.data.config,
      // Don't save in-memory logs to JSON (managed separately)
      logs: [],
      requestLogs: [],
    }
    writeFileSync(this.dataFilePath, JSON.stringify(toSave, null, 2), 'utf-8')
  }

  private normalizeConfig(config: Partial<AppConfig>): AppConfig {
    const rawConfig = { ...DEFAULT_CONFIG, ...config }
    const rawToolCallingConfig = rawConfig.toolCallingConfig ?? (rawConfig as any).toolPromptConfig

    return {
      ...rawConfig,
      modelMappings: normalizeModelMappingsWithDefaults(rawConfig.modelMappings),
      defaultModelMappingsSeeded: config.defaultModelMappingsSeeded,
      requestLogConfig: normalizeRequestLogConfig(rawConfig.requestLogConfig || DEFAULT_REQUEST_LOG_CONFIG),
      toolCallingConfig: normalizeToolCallingConfig(rawToolCallingConfig),
      toolPromptConfig: undefined,
    }
  }

  private initializeDefaultModelMappings(): void {
    if (!this.data) return
    const config = this.normalizeConfig(this.data.config)
    if (config.defaultModelMappingsSeeded) {
      this.data.config = config
      return
    }
    this.data.config = this.normalizeConfig({
      ...config,
      modelMappings: {
        ...createDefaultModelMappings(),
        ...(config.modelMappings || {}),
      },
      defaultModelMappingsSeeded: true,
    })
  }

  private async initializeDefaultProviders(): Promise<void> {
    if (!this.data) return
    const providers = this.data.providers || []
    const builtinIds = BUILTIN_PROVIDERS.map(p => p.id)

    // Ensure all builtin providers exist
    for (const builtinConfig of BUILTIN_PROVIDERS) {
      const exists = providers.some((p: Provider) => p.id === builtinConfig.id)
      if (!exists) {
        const now = Date.now()
        const newProvider: Provider = {
          id: builtinConfig.id,
          name: builtinConfig.name,
          type: 'builtin',
          authType: builtinConfig.authType,
          apiEndpoint: builtinConfig.apiEndpoint,
          chatPath: builtinConfig.chatPath,
          headers: builtinConfig.headers,
          enabled: true,
          createdAt: now,
          updatedAt: now,
          description: builtinConfig.description,
          supportedModels: builtinConfig.supportedModels,
          modelMappings: builtinConfig.modelMappings,
        }
        providers.push(newProvider)
        console.log(`[FileStore] Added builtin provider: ${builtinConfig.id}`)
      }
    }

    const validProviders = providers.filter((p: Provider) => {
      if (p.type === 'builtin') return builtinIds.includes(p.id)
      return true
    })

    const userModelOverrides: UserModelOverrides = { ...(this.data.userModelOverrides || {}) }

    const updatedProviders = validProviders.map((p: Provider) => {
      if (p.type === 'builtin') {
        const builtinConfig = BUILTIN_PROVIDERS.find(bp => bp.id === p.id)
        if (builtinConfig) {
          if (p.id === 'deepseek') {
            const sanitizedOverrides = sanitizeDeepSeekModelOverrides(userModelOverrides[p.id])
            if (JSON.stringify(sanitizedOverrides) !== JSON.stringify(userModelOverrides[p.id])) {
              userModelOverrides[p.id] = sanitizedOverrides
            }
          }
          return {
            ...p,
            apiEndpoint: builtinConfig.apiEndpoint,
            chatPath: builtinConfig.chatPath,
            supportedModels: builtinConfig.supportedModels,
            modelMappings: builtinConfig.modelMappings,
            headers: builtinConfig.headers,
            credentialFields: builtinConfig.credentialFields,
            description: builtinConfig.description,
          }
        }
      }
      return p
    })

    this.data.userModelOverrides = userModelOverrides
    this.data.providers = updatedProviders
  }

  ensureProviderExists(providerId: string): void {
    this.ensureInitialized()
    const providers = this.data!.providers
    const exists = providers.some((p: Provider) => p.id === providerId)
    if (!exists) {
      const builtinConfig = BUILTIN_PROVIDERS.find(bp => bp.id === providerId)
      if (builtinConfig) {
        const now = Date.now()
        const newProvider: Provider = {
          id: builtinConfig.id,
          name: builtinConfig.name,
          type: 'builtin',
          authType: builtinConfig.authType,
          apiEndpoint: builtinConfig.apiEndpoint,
          chatPath: builtinConfig.chatPath,
          headers: builtinConfig.headers,
          enabled: true,
          createdAt: now,
          updatedAt: now,
          description: builtinConfig.description,
          supportedModels: builtinConfig.supportedModels,
          modelMappings: builtinConfig.modelMappings,
        }
        providers.push(newProvider)
        this.data!.providers = providers
        this.saveData()
        console.log('[FileStore] Created missing provider:', providerId)
      }
    }
  }

  private ensureInitialized(): void {
    if (!this.isInitialized || !this.data) {
      throw new Error('Storage not initialized, please call initialize() first')
    }
  }

  private getLogPriority(level: LogLevel): number {
    switch (level) {
      case 'debug': return 10
      case 'info': return 20
      case 'warn': return 30
      case 'error': return 40
      default: return 20
    }
  }

  private shouldRecordLog(level: LogLevel): boolean {
    const config = this.normalizeConfig(this.data!.config)
    return this.getLogPriority(level) >= this.getLogPriority(config.logLevel)
  }

  flushPendingWrites(): void {
    this.appLogManager.flushSync()
    this.requestLogManager.flushSync()
    this.saveData()
  }

  // Simple base64 "encryption" (no real encryption on Termux, Electron safeStorage not available)
  encryptData(data: string): string {
    return Buffer.from(data).toString('base64')
  }

  decryptData(encryptedData: string): string {
    try {
      return Buffer.from(encryptedData, 'base64').toString('utf-8')
    } catch {
      return encryptedData
    }
  }

  encryptCredentials(credentials: Record<string, string>): Record<string, string> {
    const encrypted: Record<string, string> = {}
    for (const [key, value] of Object.entries(credentials)) {
      encrypted[key] = this.encryptData(value)
    }
    return encrypted
  }

  decryptCredentials(encryptedCredentials: Record<string, string>): Record<string, string> {
    const decrypted: Record<string, string> = {}
    for (const [key, value] of Object.entries(encryptedCredentials)) {
      decrypted[key] = this.decryptData(value)
    }
    return decrypted
  }

  // ==================== Provider Operations ====================

  getProviders(): Provider[] {
    this.ensureInitialized()
    return this.data!.providers
  }

  getProviderById(id: string): Provider | undefined {
    this.ensureInitialized()
    return this.data!.providers.find((p: Provider) => p.id === id)
  }

  addProvider(provider: Provider): void {
    this.ensureInitialized()
    this.data!.providers.push(provider)
    this.saveData()
  }

  updateProvider(id: string, updates: Partial<Provider>): Provider | null {
    this.ensureInitialized()
    const providers = this.data!.providers
    const index = providers.findIndex((p: Provider) => p.id === id)
    if (index === -1) return null
    providers[index] = { ...providers[index], ...updates, updatedAt: Date.now() }
    this.saveData()
    return providers[index]
  }

  deleteProvider(id: string): boolean {
    this.ensureInitialized()
    const providers = this.data!.providers
    const index = providers.findIndex((p: Provider) => p.id === id)
    if (index === -1) return false
    providers.splice(index, 1)
    this.data!.accounts = this.data!.accounts.filter((a: Account) => a.providerId !== id)
    this.saveData()
    return true
  }

  // ==================== Model Overrides ====================

  getModelOverrides(providerId: string): ProviderModelOverrides | undefined {
    this.ensureInitialized()
    const userModelOverrides = this.data!.userModelOverrides || DEFAULT_USER_MODEL_OVERRIDES
    return userModelOverrides[providerId]
  }

  hasModelOverrides(providerId: string): boolean {
    const overrides = this.getModelOverrides(providerId)
    if (!overrides) return false
    return (overrides.addedModels && overrides.addedModels.length > 0) ||
      (overrides.excludedModels && overrides.excludedModels.length > 0)
  }

  // ==================== Account Operations ====================

  getAccounts(includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = this.data!.accounts
    if (includeCredentials) {
      return accounts.map((account: Account) => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }
    return accounts
  }

  getAccountById(id: string, includeCredentials: boolean = false): Account | undefined {
    this.ensureInitialized()
    const account = this.data!.accounts.find((a: Account) => a.id === id)
    if (account && includeCredentials) {
      return { ...account, credentials: this.decryptCredentials(account.credentials) }
    }
    return account
  }

  getAccountsByProviderId(providerId: string, includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const filtered = this.data!.accounts.filter((a: Account) => a.providerId === providerId)
    if (includeCredentials) {
      return filtered.map((account: Account) => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }
    return filtered
  }

  addAccount(account: Account): void {
    this.ensureInitialized()
    const encryptedAccount: Account = {
      ...account,
      credentials: this.encryptCredentials(account.credentials),
    }
    this.data!.accounts.push(encryptedAccount)
    this.saveData()
  }

  updateAccount(id: string, updates: Partial<Account>): Account | null {
    this.ensureInitialized()
    const accounts = this.data!.accounts
    const index = accounts.findIndex((a: Account) => a.id === id)
    if (index === -1) return null
    const updatedAccount: Account = { ...accounts[index], ...updates, updatedAt: Date.now() }
    if (updates.credentials) {
      updatedAccount.credentials = this.encryptCredentials(updates.credentials)
    }
    accounts[index] = updatedAccount
    this.saveData()
    return {
      ...updatedAccount,
      credentials: updates.credentials || this.decryptCredentials(accounts[index].credentials),
    }
  }

  deleteAccount(id: string): boolean {
    this.ensureInitialized()
    const accounts = this.data!.accounts
    const index = accounts.findIndex((a: Account) => a.id === id)
    if (index === -1) return false
    accounts.splice(index, 1)
    this.saveData()
    return true
  }

  getActiveAccounts(includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = this.data!.accounts.filter((a: Account) => a.status === 'active')
    if (includeCredentials) {
      return accounts.map((account: Account) => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }
    return accounts
  }

  // ==================== Configuration Operations ====================

  getConfig(): AppConfig {
    this.ensureInitialized()
    return this.normalizeConfig(this.data!.config || DEFAULT_CONFIG)
  }

  setConfig(config: AppConfig): void {
    this.ensureInitialized()
    const normalized = this.normalizeConfig(config)
    this.data!.config = normalized
    this.requestLogManager.setConfig(normalized.requestLogConfig)
    this.saveData()
  }

  updateConfig(updates: Partial<AppConfig>): AppConfig {
    this.ensureInitialized()
    const currentConfig = this.getConfig()
    const newConfig: AppConfig = { ...currentConfig, ...updates }

    if ((updates as any).toolCallingConfig || (updates as any).toolPromptConfig) {
      const incoming = (updates as any).toolCallingConfig ?? (updates as any).toolPromptConfig
      const incomingRecord = incoming && typeof incoming === 'object' ? incoming as Record<string, unknown> : {}
      const incomingAdvanced = incomingRecord.advanced && typeof incomingRecord.advanced === 'object'
        ? incomingRecord.advanced as Record<string, unknown>
        : {}
      newConfig.toolCallingConfig = normalizeToolCallingConfig({
        ...currentConfig.toolCallingConfig,
        ...incomingRecord,
        advanced: { ...currentConfig.toolCallingConfig.advanced, ...incomingAdvanced },
      })
      ;(newConfig as any).toolPromptConfig = undefined
    }

    if (updates.sessionConfig && currentConfig.sessionConfig) {
      newConfig.sessionConfig = { ...currentConfig.sessionConfig, ...updates.sessionConfig }
    }

    if (updates.requestLogConfig) {
      newConfig.requestLogConfig = normalizeRequestLogConfig({
        ...currentConfig.requestLogConfig,
        ...updates.requestLogConfig,
      })
    }

    const normalized = this.normalizeConfig(newConfig)
    this.data!.config = normalized
    this.appLogManager.setMaxEntries(this.getMaxLogEntries(normalized))
    this.requestLogManager.setConfig(normalized.requestLogConfig)
    this.saveData()
    return normalized
  }

  resetConfig(): AppConfig {
    this.ensureInitialized()
    this.data!.config = DEFAULT_CONFIG
    this.appLogManager.setMaxEntries(this.getMaxLogEntries(DEFAULT_CONFIG))
    this.requestLogManager.setConfig(DEFAULT_CONFIG.requestLogConfig)
    this.saveData()
    return DEFAULT_CONFIG
  }

  private getMaxLogEntries(config: AppConfig): number {
    return config.logRetentionDays * 1000
  }

  // ==================== Log Operations ====================

  addLog(level: LogLevel, message: string, data?: {
    accountId?: string; providerId?: string; requestId?: string
    data?: Record<string, unknown>; model?: string; actualModel?: string
    latency?: number; isStream?: boolean; error?: string
  }): LogEntry {
    this.ensureInitialized()
    const entry: LogEntry = {
      id: this.generateId(),
      timestamp: Date.now(),
      level,
      message,
      ...data,
    }
    if (this.shouldRecordLog(level)) {
      this.appLogManager.addLog(entry)
    }
    return entry
  }

  getLogs(filter?: { level?: LogLevel; limit?: number }): LogEntry[] {
    this.ensureInitialized()
    return this.appLogManager.getLogs(filter)
  }

  clearLogs(): void {
    this.ensureInitialized()
    this.appLogManager.clearLogs()
    this.data!.logs = []
  }

  replaceLogs(logs: LogEntry[]): void {
    this.ensureInitialized()
    this.appLogManager.replaceLogs(logs)
    this.data!.logs = []
  }

  getLogStats(): { total: number; info: number; warn: number; error: number; debug: number } {
    this.ensureInitialized()
    return this.appLogManager.getStats()
  }

  getLogTrend(days: number = 7): { date: string; total: number; info: number; warn: number; error: number }[] {
    this.ensureInitialized()
    return this.appLogManager.getTrend(days)
  }

  getAccountLogTrend(accountId: string, days: number = 7): { date: string; total: number; info: number; warn: number; error: number }[] {
    this.ensureInitialized()
    return this.appLogManager.getAccountTrend(accountId, days)
  }

  exportLogs(format: 'json' | 'txt' = 'json'): string {
    this.ensureInitialized()
    const logs = this.appLogManager.exportLogs()
    if (format === 'json') return JSON.stringify(logs, null, 2)
    return logs.map((log: LogEntry) => {
      const time = new Date(log.timestamp).toISOString()
      const level = log.level.toUpperCase().padEnd(5)
      let line = `[${time}] [${level}] ${log.message}`
      if (log.providerId) line += ` | Provider: ${log.providerId}`
      if (log.accountId) line += ` | Account: ${log.accountId}`
      if (log.requestId) line += ` | Request: ${log.requestId}`
      if (log.data) line += ` | Data: ${JSON.stringify(log.data)}`
      return line
    }).join('\n')
  }

  getLogById(id: string): LogEntry | undefined {
    this.ensureInitialized()
    return this.appLogManager.exportLogs().find((l: LogEntry) => l.id === id)
  }

  cleanExpiredLogs(): void {
    this.ensureInitialized()
    const config = this.getConfig()
    const logs = this.appLogManager.exportLogs()
    const cutoff = Date.now() - config.logRetentionDays * 24 * 60 * 60 * 1000
    const filtered = logs.filter((l: LogEntry) => l.timestamp >= cutoff)
    this.appLogManager.replaceLogs(filtered)
    this.data!.logs = []
  }

  // ==================== Request Log Operations ====================

  addRequestLog(entry: Omit<RequestLogEntry, 'id'>): RequestLogEntry {
    this.ensureInitialized()
    return this.requestLogManager.addRequestLog(entry)
  }

  updateRequestLog(id: string, updates: Partial<RequestLogEntry>): boolean {
    this.ensureInitialized()
    return this.requestLogManager.updateRequestLog(id, updates)
  }

  getRequestLogs(limit?: number, filter?: { status?: 'success' | 'error'; providerId?: string }): RequestLogEntry[] {
    this.ensureInitialized()
    return this.requestLogManager.getRequestLogs(limit, filter)
  }

  getRequestLogById(id: string): RequestLogEntry | undefined {
    this.ensureInitialized()
    return this.requestLogManager.getRequestLogById(id)
  }

  clearRequestLogs(): void {
    this.ensureInitialized()
    this.requestLogManager.clearRequestLogs()
    this.data!.statistics = DEFAULT_STATISTICS
  }

  getRequestLogStats(): { total: number; success: number; error: number; todayTotal: number; todaySuccess: number; todayError: number } {
    this.ensureInitialized()
    return this.requestLogManager.getRequestLogStats()
  }

  getRequestLogTrend(days: number = 7): { date: string; total: number; success: number; error: number; avgLatency: number }[] {
    this.ensureInitialized()
    return this.requestLogManager.getRequestLogTrend(days)
  }

  // ==================== Statistics Operations ====================

  getStatistics(): PersistentStatistics {
    this.ensureInitialized()
    return this.data!.statistics || DEFAULT_STATISTICS
  }

  updateStatistics(updates: Partial<PersistentStatistics>): PersistentStatistics {
    this.ensureInitialized()
    const currentStats = this.data!.statistics || DEFAULT_STATISTICS
    const newStats = { ...currentStats, ...updates, lastUpdated: Date.now() }
    this.data!.statistics = newStats
    this.saveData()
    return newStats
  }

  recordRequestInStats(success: boolean, latency: number, model?: string, providerId?: string, accountId?: string): PersistentStatistics {
    this.ensureInitialized()
    const stats = this.data!.statistics || DEFAULT_STATISTICS
    const today = new Date().toISOString().split('T')[0]

    const newStats: PersistentStatistics = {
      ...stats,
      totalRequests: stats.totalRequests + 1,
      successRequests: success ? stats.successRequests + 1 : stats.successRequests,
      failedRequests: success ? stats.failedRequests : stats.failedRequests + 1,
      totalLatency: success ? stats.totalLatency + latency : stats.totalLatency,
      lastUpdated: Date.now(),
      modelUsage: { ...stats.modelUsage },
      providerUsage: { ...stats.providerUsage },
      accountUsage: { ...stats.accountUsage },
      dailyStats: { ...stats.dailyStats },
    }

    if (model) newStats.modelUsage[model] = (newStats.modelUsage[model] || 0) + 1
    if (providerId) newStats.providerUsage[providerId] = (newStats.providerUsage[providerId] || 0) + 1
    if (accountId) newStats.accountUsage[accountId] = (newStats.accountUsage[accountId] || 0) + 1

    if (!newStats.dailyStats[today]) {
      newStats.dailyStats[today] = {
        date: today, totalRequests: 0, successRequests: 0, failedRequests: 0,
        totalLatency: 0, modelUsage: {}, providerUsage: {},
      }
    }
    newStats.dailyStats[today].totalRequests++
    if (success) {
      newStats.dailyStats[today].successRequests++
      newStats.dailyStats[today].totalLatency += latency
    } else {
      newStats.dailyStats[today].failedRequests++
    }
    if (model) newStats.dailyStats[today].modelUsage[model] = (newStats.dailyStats[today].modelUsage[model] || 0) + 1
    if (providerId) newStats.dailyStats[today].providerUsage[providerId] = (newStats.dailyStats[today].providerUsage[providerId] || 0) + 1

    this.data!.statistics = newStats
    this.saveData()
    return newStats
  }

  getTodayStatistics(): DailyStatistics {
    this.ensureInitialized()
    const stats = this.data!.statistics || DEFAULT_STATISTICS
    const today = new Date().toISOString().split('T')[0]
    return stats.dailyStats[today] || {
      date: today, totalRequests: 0, successRequests: 0, failedRequests: 0,
      totalLatency: 0, modelUsage: {}, providerUsage: {},
    }
  }

  cleanOldDailyStats(): void {
    this.ensureInitialized()
    const stats = this.data!.statistics || DEFAULT_STATISTICS
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    const cutoffDate = new Date(cutoff).toISOString().split('T')[0]
    const filteredDailyStats: Record<string, DailyStatistics> = {}
    for (const [date, dayStats] of Object.entries(stats.dailyStats)) {
      if (date >= cutoffDate) filteredDailyStats[date] = dayStats as DailyStatistics
    }
    if (Object.keys(filteredDailyStats).length !== Object.keys(stats.dailyStats).length) {
      stats.dailyStats = filteredDailyStats
      this.data!.statistics = stats
      this.saveData()
    }
  }

  // ==================== System Prompts Operations ====================

  getSystemPrompts(): SystemPrompt[] {
    this.ensureInitialized()
    const customPrompts = this.data!.systemPrompts || []
    return [...BUILTIN_PROMPTS, ...customPrompts]
  }

  getBuiltinPrompts(): SystemPrompt[] {
    return BUILTIN_PROMPTS
  }

  getCustomPrompts(): SystemPrompt[] {
    this.ensureInitialized()
    return this.data!.systemPrompts || []
  }

  getSystemPromptById(id: string): SystemPrompt | undefined {
    return this.getSystemPrompts().find(p => p.id === id)
  }

  addSystemPrompt(prompt: Omit<SystemPrompt, 'id' | 'createdAt' | 'updatedAt'>): SystemPrompt {
    this.ensureInitialized()
    const newPrompt: SystemPrompt = {
      ...prompt, id: this.generateId(), isBuiltin: false,
      createdAt: Date.now(), updatedAt: Date.now(),
    }
    this.data!.systemPrompts.push(newPrompt)
    this.saveData()
    return newPrompt
  }

  updateSystemPrompt(id: string, updates: Partial<SystemPrompt>): SystemPrompt | null {
    this.ensureInitialized()
    if (BUILTIN_PROMPTS.some(p => p.id === id)) {
      console.warn('Cannot update built-in prompt:', id)
      return null
    }
    const prompts = this.data!.systemPrompts
    const index = prompts.findIndex((p: SystemPrompt) => p.id === id)
    if (index === -1) return null
    prompts[index] = { ...prompts[index], ...updates, updatedAt: Date.now() }
    this.saveData()
    return prompts[index]
  }

  deleteSystemPrompt(id: string): boolean {
    this.ensureInitialized()
    if (BUILTIN_PROMPTS.some(p => p.id === id)) {
      console.warn('Cannot delete built-in prompt:', id)
      return false
    }
    const prompts = this.data!.systemPrompts
    const index = prompts.findIndex((p: SystemPrompt) => p.id === id)
    if (index === -1) return false
    prompts.splice(index, 1)
    this.saveData()
    return true
  }

  getSystemPromptsByType(type: SystemPrompt['type']): SystemPrompt[] {
    return this.getSystemPrompts().filter(p => p.type === type)
  }

  // ==================== Session Operations ====================

  getSessionConfig(): SessionConfig {
    this.ensureInitialized()
    const config = this.data!.config || DEFAULT_CONFIG
    return config.sessionConfig || DEFAULT_SESSION_CONFIG
  }

  updateSessionConfig(updates: Partial<SessionConfig>): SessionConfig {
    this.ensureInitialized()
    const currentConfig = this.data!.config || DEFAULT_CONFIG
    const newSessionConfig = { ...(currentConfig.sessionConfig || DEFAULT_SESSION_CONFIG), ...updates }
    const newConfig = { ...currentConfig, sessionConfig: newSessionConfig }
    this.data!.config = newConfig
    this.saveData()
    return newSessionConfig
  }

  getSessions(): SessionRecord[] {
    this.ensureInitialized()
    return this.data!.sessions || []
  }

  getSessionById(id: string): SessionRecord | undefined {
    this.ensureInitialized()
    return (this.data!.sessions || []).find((s: SessionRecord) => s.id === id)
  }

  getActiveSessions(): SessionRecord[] {
    this.ensureInitialized()
    const sessions = this.data!.sessions || []
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()
    return sessions.filter((s: SessionRecord) =>
      s.status === 'active' && (now - s.lastActiveAt) < timeoutMs
    )
  }

  addSession(session: SessionRecord): void {
    this.ensureInitialized()
    this.data!.sessions.push(session)
    this.saveData()
  }

  updateSession(id: string, updates: Partial<SessionRecord>): SessionRecord | null {
    this.ensureInitialized()
    const sessions = this.data!.sessions
    const index = sessions.findIndex((s: SessionRecord) => s.id === id)
    if (index === -1) return null
    sessions[index] = { ...sessions[index], ...updates }
    this.saveData()
    return sessions[index]
  }

  addMessageToSession(sessionId: string, message: ChatMessage): SessionRecord | null {
    this.ensureInitialized()
    const sessions = this.data!.sessions
    const index = sessions.findIndex((s: SessionRecord) => s.id === sessionId)
    if (index === -1) return null
    const config = this.getSessionConfig()
    const session = sessions[index]
    if (session.messages.length >= config.maxMessagesPerSession) {
      session.messages = session.messages.slice(-config.maxMessagesPerSession + 1)
    }
    session.messages.push(message)
    session.lastActiveAt = Date.now()
    sessions[index] = session
    this.saveData()
    return session
  }

  deleteSession(id: string): boolean {
    this.ensureInitialized()
    const sessions = this.data!.sessions
    const index = sessions.findIndex((s: SessionRecord) => s.id === id)
    if (index === -1) return false
    sessions.splice(index, 1)
    this.saveData()
    return true
  }

  expireSession(id: string): SessionRecord | null {
    return this.updateSession(id, { status: 'expired' })
  }

  cleanExpiredSessions(): number {
    this.ensureInitialized()
    const sessions = this.data!.sessions || []
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()
    let removedCount = 0

    let remainingSessions = sessions.filter((s: SessionRecord) => {
      if (s.status === 'expired') { removedCount++; return false }
      return true
    })

    if (config.deleteAfterTimeout) {
      remainingSessions = remainingSessions.filter((s: SessionRecord) => {
        if (s.status === 'active' && (now - s.lastActiveAt) >= timeoutMs) { removedCount++; return false }
        return true
      })
    } else {
      remainingSessions = remainingSessions.map((s: SessionRecord) => {
        if (s.status === 'active' && (now - s.lastActiveAt) >= timeoutMs) { removedCount++; return { ...s, status: 'expired' as const } }
        return s
      })
    }

    this.data!.sessions = remainingSessions
    this.saveData()
    return removedCount
  }

  getSessionsByAccountId(accountId: string): SessionRecord[] {
    this.ensureInitialized()
    return (this.data!.sessions || []).filter((s: SessionRecord) => s.accountId === accountId)
  }

  getSessionsByProviderId(providerId: string): SessionRecord[] {
    this.ensureInitialized()
    return (this.data!.sessions || []).filter((s: SessionRecord) => s.providerId === providerId)
  }

  clearAllSessions(): void {
    this.ensureInitialized()
    this.data!.sessions = []
    this.saveData()
  }

  // ==================== Model Management Operations ====================

  private getUserModelOverrides(): UserModelOverrides {
    this.ensureInitialized()
    return this.data!.userModelOverrides || DEFAULT_USER_MODEL_OVERRIDES
  }

  private setUserModelOverrides(overrides: UserModelOverrides): void {
    this.ensureInitialized()
    this.data!.userModelOverrides = overrides
    this.saveData()
  }

  private getProviderModelOverrides(providerId: string): ProviderModelOverrides {
    const overrides = this.getUserModelOverrides()
    return overrides[providerId] || { addedModels: [], excludedModels: [] }
  }

  getEffectiveModels(providerId: string): EffectiveModel[] {
    this.ensureInitialized()
    const provider = this.getProviderById(providerId)
    if (!provider) return []

    const defaultModels = provider.supportedModels || []
    const modelMappings = provider.modelMappings || {}
    const overrides = this.getProviderModelOverrides(providerId)
    const effectiveModels: EffectiveModel[] = []

    defaultModels.forEach(displayName => {
      if (!overrides.excludedModels.includes(displayName)) {
        const actualModelId = modelMappings[displayName] || displayName
        effectiveModels.push({ displayName, actualModelId, isCustom: false })
      }
    })

    overrides.addedModels.forEach(customModel => {
      effectiveModels.push({ displayName: customModel.displayName, actualModelId: customModel.actualModelId, isCustom: true })
    })

    return effectiveModels
  }

  addCustomModel(providerId: string, model: CustomModel): EffectiveModel[] {
    this.ensureInitialized()
    const overrides = this.getUserModelOverrides()
    if (!overrides[providerId]) overrides[providerId] = { addedModels: [], excludedModels: [] }
    const existing = overrides[providerId].addedModels.find(
      m => m.displayName === model.displayName || m.actualModelId === model.actualModelId
    )
    if (existing) throw new Error(`Model "${model.displayName}" already exists`)
    overrides[providerId].addedModels.push(model)
    this.setUserModelOverrides(overrides)
    return this.getEffectiveModels(providerId)
  }

  removeModel(providerId: string, modelName: string): EffectiveModel[] {
    this.ensureInitialized()
    const provider = this.getProviderById(providerId)
    if (!provider) throw new Error('Provider not found')
    const overrides = this.getUserModelOverrides()
    if (!overrides[providerId]) overrides[providerId] = { addedModels: [], excludedModels: [] }
    const defaultModels = provider.supportedModels || []
    if (defaultModels.includes(modelName)) {
      if (!overrides[providerId].excludedModels.includes(modelName)) {
        overrides[providerId].excludedModels.push(modelName)
      }
    } else {
      overrides[providerId].addedModels = overrides[providerId].addedModels.filter(m => m.displayName !== modelName)
    }
    this.setUserModelOverrides(overrides)
    return this.getEffectiveModels(providerId)
  }

  resetModels(providerId: string): EffectiveModel[] {
    this.ensureInitialized()
    const overrides = this.getUserModelOverrides()
    if (overrides[providerId]) {
      delete overrides[providerId]
      this.setUserModelOverrides(overrides)
    }
    const builtinConfig = BUILTIN_PROVIDERS.find(provider => provider.id === providerId)
    if (builtinConfig) {
      const providers = this.data!.providers.map(provider => {
        if (provider.id !== providerId || provider.type !== 'builtin') return provider
        return {
          ...provider, apiEndpoint: builtinConfig.apiEndpoint, chatPath: builtinConfig.chatPath,
          supportedModels: builtinConfig.supportedModels, modelMappings: builtinConfig.modelMappings,
          headers: builtinConfig.headers, credentialFields: builtinConfig.credentialFields,
          description: builtinConfig.description, updatedAt: Date.now(),
        }
      })
      this.data!.providers = providers
      this.saveData()
    }
    return this.getEffectiveModels(providerId)
  }

  // ==================== Utility Methods ====================

  generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }

  getStore(): any {
    return null
  }

  clearAll(): void {
    this.ensureInitialized()
    this.appLogManager.clearLogs()
    this.appLogManager.flushSync()
    this.data = this.getDefaultData()
    this.requestLogManager.clearRequestLogs()
    this.requestLogManager.flushSync()
    this.saveData()
  }

  exportData(): Omit<StoreSchema, 'accounts'> & { accounts: Omit<Account, 'credentials'>[] } {
    this.ensureInitialized()
    const providers = this.data!.providers
    const accounts = this.data!.accounts.map((a: Account) => {
      const { credentials, ...rest } = a
      return rest
    })
    const config = this.data!.config || DEFAULT_CONFIG
    const logs = this.appLogManager.exportLogs()
    const requestLogs = this.requestLogManager.exportRequestLogs()
    const systemPrompts = this.data!.systemPrompts || []
    const sessions = this.data!.sessions || []
    const statistics = this.data!.statistics || DEFAULT_STATISTICS
    const userModelOverrides = this.data!.userModelOverrides || DEFAULT_USER_MODEL_OVERRIDES

    return { providers, accounts, config, logs, requestLogs, systemPrompts, sessions, statistics, userModelOverrides }
  }

  getStorePath(): string {
    return this.storagePath
  }
}

// Use globalThis singleton to ensure same instance is shared
// between ESM (import) and CJS (require) module systems
const GLOBAL_STORE_KEY = '__CHAT2API_TERMUX_STORE_MANAGER__'

const globalStore = (globalThis as any)[GLOBAL_STORE_KEY] as FileStoreManager | undefined
if (!globalStore) {
  (globalThis as any)[GLOBAL_STORE_KEY] = new FileStoreManager()
}

export const storeManager: FileStoreManager = (globalThis as any)[GLOBAL_STORE_KEY]
export default storeManager