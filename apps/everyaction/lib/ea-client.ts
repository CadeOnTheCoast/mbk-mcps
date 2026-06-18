/**
 * EveryAction REST API v4 client
 *
 * Auth: Basic auth where username = appName, password = "{apiKey}|{mode}"
 *   mode 0 = VAN (canvassing/field)
 *   mode 1 = MyCampaign (donor/CRM — use this for MBK)
 *
 * Docs: https://docs.everyaction.com/reference
 */



// Simple logger interface -- console-based in production, no external dep
interface Logger {
  debug: (msg: string, meta?: unknown) => void
  info:  (msg: string, meta?: unknown) => void
  warn:  (msg: string, meta?: unknown) => void
  error: (msg: string, meta?: unknown) => void
}

export interface EAClientConfig {
  apiKey: string
  appName: string
  /** 0 = VAN, 1 = MyCampaign (default). Use 1 for donor/CRM work. */
  mode?: string
  baseUrl?: string
  timeoutMs?: number
  maxRetries?: number
  retryBaseMs?: number
  fetchImpl?: typeof fetch
  logger?: Logger
  contactTypeIds?: {
    phone_call?: number
    in_person_meeting?: number
    email?: number
    text?: number
  }
}

export interface EAPerson {
  vanId: number
  firstName: string | null
  lastName: string | null
  emails?: Array<{ email: string; isPrimary: boolean }>
  phones?: Array<{ phoneNumber: string; phoneType: string }>
  addresses?: Array<{
    addressLine1: string | null
    city: string | null
    stateOrProvince: string | null
    zipOrPostalCode: string | null
    isPrimary: boolean
  }>
  employer?: string | null
  occupation?: string | null
}

export interface EAContact {
  dateCanvassed: string
  contactTypeId: number
  inputTypeId: number
  notes?: Array<{ text: string; isViewRestricted?: boolean }>
  resultCodeId?: number | null
}

export interface EANote {
  noteId?: number
  text: string
  isViewRestricted?: boolean
  createdByName?: string
  dateCreated?: string   // legacy field name (may not be returned)
  createdDate?: string   // EA actually returns this casing
}

export interface EAFindResult {
  vanId: number
  firstName: string | null
  lastName: string | null
  emails?: Array<{ email: string }>
  phones?: Array<{ phoneNumber: string }>
}

export interface EAActivistCode {
  activistCodeId: number
  name?: string | null
  activistCodeName?: string | null
  status?: string | null
}

export interface EAContactType {
  contactTypeId: number
  name?: string | null
  contactTypeName?: string | null
}

export interface EAInteraction {
  contactId?: number
  dateCanvassed?: string
  contactTypeId?: number
  contactTypeName?: string | null
  resultCodeId?: number | null
  resultCodeName?: string | null
  notes?: Array<{ text: string }>
  createdByName?: string | null
}

export interface EAResultCode {
  resultCodeId: number
  name?: string | null
  resultCodeName?: string | null
}

export const DEFAULT_CONTACT_TYPES = {
  phone_call: 1,
  walk: 2,
  email: 37,
  text: 51,
  in_person_meeting: 19,
  note: 37,
} as const

const INPUT_TYPE_MANUAL = 11

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

function parseRetryAfterMs(headerValue: string | null) {
  if (!headerValue) return null

  const seconds = Number.parseInt(headerValue, 10)
  if (Number.isFinite(seconds)) return Math.max(seconds * 1000, 0)

  const dateMs = Date.parse(headerValue)
  if (Number.isFinite(dateMs)) return Math.max(dateMs - Date.now(), 0)

  return null
}

function createNoopLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
}

export class EAClient {
  private readonly baseUrl: string
  private readonly authHeader: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly retryBaseMs: number
  private readonly logger: Logger
  private readonly contactTypeIds: {
    phone_call: number
    in_person_meeting: number
    email: number
    text: number
  }

  constructor(config: EAClientConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.everyaction.com').replace(/\/$/, '')
    const password = `${config.apiKey}|${config.mode ?? '1'}`
    this.authHeader = 'Basic ' + Buffer.from(`${config.appName}:${password}`).toString('base64')
    this.fetchImpl = config.fetchImpl ?? fetch
    this.timeoutMs = config.timeoutMs ?? 15_000
    this.maxRetries = config.maxRetries ?? 3
    this.retryBaseMs = config.retryBaseMs ?? 500
    this.logger = config.logger ?? createNoopLogger()
    this.contactTypeIds = {
      phone_call: config.contactTypeIds?.phone_call ?? DEFAULT_CONTACT_TYPES.phone_call,
      in_person_meeting: config.contactTypeIds?.in_person_meeting ?? DEFAULT_CONTACT_TYPES.in_person_meeting,
      email: config.contactTypeIds?.email ?? DEFAULT_CONTACT_TYPES.email,
      text: config.contactTypeIds?.text ?? DEFAULT_CONTACT_TYPES.text,
    }
  }

  private buildUrl(path: string, params?: Record<string, string>) {
    let url = `${this.baseUrl}/v4${path}`
    if (params) {
      const qs = new URLSearchParams(params).toString()
      url += `?${qs}`
    }
    return url
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string>
  ): Promise<T> {
    const url = this.buildUrl(path, params)

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'mcp-everyaction/1.0.0',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        })

        clearTimeout(timeout)

        if (res.ok) {
          if (res.status === 204) return undefined as unknown as T
          return res.json() as Promise<T>
        }

        const text = await res.text().catch(() => '')
        const error = new Error(`EA API ${method} ${path} -> ${res.status}: ${text}`)

        if (attempt < this.maxRetries && isRetryableStatus(res.status)) {
          const retryAfter = parseRetryAfterMs(res.headers.get('retry-after'))
          const backoff = retryAfter ?? this.retryBaseMs * 2 ** attempt
          this.logger.warn('Retrying EveryAction request after retryable status', {
            method,
            path,
            status: res.status,
            attempt: attempt + 1,
            backoff,
          })
          await sleep(backoff)
          continue
        }

        throw error
      } catch (error) {
        clearTimeout(timeout)
        const message = error instanceof Error ? error.message : String(error)
        const isAbort = error instanceof Error && error.name === 'AbortError'
        const isRetryableNetworkError = isAbort || message.includes('fetch failed') || message.includes('ECONNRESET')

        if (attempt < this.maxRetries && isRetryableNetworkError) {
          const backoff = this.retryBaseMs * 2 ** attempt
          this.logger.warn('Retrying EveryAction request after network failure', {
            method,
            path,
            attempt: attempt + 1,
            backoff,
            error: message,
          })
          await sleep(backoff)
          continue
        }

        throw error
      }
    }

    throw new Error(`EA API ${method} ${path} exhausted all retries`)
  }

  async validateConnection(): Promise<void> {
    await this.listActivistCodes(1)
  }

  getContactTypeId(type: 'phone_call' | 'in_person_meeting' | 'email' | 'text') {
    return this.contactTypeIds[type]
  }

  /** Find people by name / email.
   *
   * Strategy:
   * 1. POST /people/find  — EA's deduplication endpoint; high confidence but requires
   *    multiple identifying fields. Returns 404 "Unmatched" when confidence is too low.
   * 2. GET /people with direct query params — broader name search.
   * 3. GET /people with OData $filter — last resort, widest net.
   */
  async findPeople(query: {
    firstName?: string
    lastName?: string
    email?: string
    phone?: string
  }): Promise<{ items: EAFindResult[]; count: number }> {
    const { firstName, lastName, email, phone } = query

    // --- Attempt 1: strict deduplication find ---
    const body: Record<string, string> = {}
    if (firstName) body.firstName = firstName
    if (lastName) body.lastName = lastName
    if (email) body.email = email
    if (phone) body.phone = phone

    try {
      const result = await this.request<{ items: EAFindResult[]; count: number }>('POST', '/people/find', body)
      if (result.items?.length) return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 404 "Unmatched" is expected when confidence is too low — fall through to broader search
      if (!message.includes('404')) throw error
    }

    // --- Attempt 2: GET /people with direct query params ---
    try {
      const params: Record<string, string> = { $top: '25' }
      if (firstName) params.firstName = firstName
      if (lastName) params.lastName = lastName
      if (email) params.email = email
      const result = await this.request<{ items: EAFindResult[]; count: number }>(
        'GET', '/people', undefined, params
      )
      if (result.items?.length) return { items: result.items, count: result.count ?? result.items.length }
    } catch {
      // fall through
    }

    // --- Attempt 3: OData $filter ---
    try {
      const filters: string[] = []
      if (lastName) filters.push(`lastName eq '${lastName.replace(/'/g, "''")}'`)
      if (firstName) filters.push(`firstName eq '${firstName.replace(/'/g, "''")}'`)
      if (filters.length) {
        const result = await this.request<{ items: EAFindResult[]; count: number }>(
          'GET', '/people', undefined,
          { $filter: filters.join(' and '), $top: '25' }
        )
        if (result.items?.length) return { items: result.items, count: result.count ?? result.items.length }
      }
    } catch {
      // fall through
    }

    // --- Attempt 4: OData startswith (partial match) ---
    try {
      const filters: string[] = []
      if (lastName) filters.push(`startswith(lastName,'${lastName.replace(/'/g, "''")}')`)
      if (firstName) filters.push(`startswith(firstName,'${firstName.replace(/'/g, "''")}')`)
      if (filters.length) {
        const result = await this.request<{ items: EAFindResult[]; count: number }>(
          'GET', '/people', undefined,
          { $filter: filters.join(' and '), $top: '25' }
        )
        if (result.items?.length) return { items: result.items, count: result.count ?? result.items.length }
      }
    } catch {
      // fall through
    }

    return { items: [], count: 0 }
  }

  async getPerson(vanId: number): Promise<EAPerson> {
    return this.request<EAPerson>('GET', `/people/${vanId}`)
  }

  async getNotes(vanId: number): Promise<{ items: EANote[]; count: number }> {
    return this.request<{ items: EANote[]; count: number }>(
      'GET',
      `/people/${vanId}/notes`,
      undefined,
      { $top: '25', $orderby: 'CreatedDate desc' }
    )
  }

  async addNote(vanId: number, text: string, isPrivate = false): Promise<EANote> {
    return this.request<EANote>('POST', `/people/${vanId}/notes`, {
      text,
      isViewRestricted: isPrivate,
    })
  }

  async logContact(
    vanId: number,
    contactTypeId: number,
    noteText: string,
    dateCanvassed?: string
  ): Promise<void> {
    const payload: EAContact = {
      dateCanvassed: dateCanvassed ?? new Date().toISOString().split('T')[0],
      contactTypeId,
      inputTypeId: INPUT_TYPE_MANUAL,
      resultCodeId: null,
    }

    if (noteText) {
      payload.notes = [{ text: noteText, isViewRestricted: false }]
    }

    await this.request<void>('POST', `/people/${vanId}/contacts`, payload)
  }

  async logContactFull(vanId: number, params: {
    contactTypeId: number
    dateCanvassed?: string
    resultCodeId?: number | null
    noteText?: string
  }): Promise<void> {
    const payload: Record<string, unknown> = {
      dateCanvassed: params.dateCanvassed ?? new Date().toISOString().split('T')[0],
      contactTypeId: params.contactTypeId,
      inputTypeId: INPUT_TYPE_MANUAL,
      resultCodeId: params.resultCodeId ?? null,
    }
    if (params.noteText) {
      payload.notes = [{ text: params.noteText, isViewRestricted: false }]
    }
    await this.request<void>('POST', `/people/${vanId}/contacts`, payload)
  }

  async getInteractions(vanId: number): Promise<{ items: EAInteraction[]; count: number }> {
    return this.request<{ items: EAInteraction[]; count: number }>(
      'GET', `/people/${vanId}/contacts`, undefined,
      { $top: '25', $orderby: 'dateCanvassed desc' }
    )
  }

  async listResultCodes(contactTypeId?: number): Promise<{ items: EAResultCode[] }> {
    const params: Record<string, string> = { $top: '100' }
    if (contactTypeId) params.contactTypeId = String(contactTypeId)
    return this.request<{ items: EAResultCode[] }>('GET', '/canvassResponses/resultCodes', undefined, params)
  }

  async findContactTypeByName(name: string): Promise<EAContactType | null> {
    const needle = name.trim().toLowerCase()
    if (!needle) return null
    const result = await this.listContactTypes()
    const items = result.items ?? []
    return (
      items.find(i => (i.name ?? i.contactTypeName ?? '').toLowerCase() === needle) ??
      items.find(i => (i.name ?? i.contactTypeName ?? '').toLowerCase().includes(needle)) ??
      null
    )
  }

  async getActivistCodes(vanId: number): Promise<{ items: Array<{ activistCodeId: number; activistCodeName: string }> }> {
    return this.request('GET', `/people/${vanId}/activistCodes`)
  }

  async listActivistCodes(limit = 250): Promise<{ items: EAActivistCode[]; count: number }> {
    return this.request<{ items: EAActivistCode[]; count: number }>(
      'GET',
      '/activistCodes',
      undefined,
      { $top: String(limit) }
    )
  }

  async listContactTypes(limit = 200): Promise<{ items: EAContactType[]; count: number }> {
    return this.request<{ items: EAContactType[]; count: number }>(
      'GET',
      '/canvassResponses/contactTypes',
      undefined,
      { $top: String(limit) }
    )
  }

  async findActivistCodeByName(name: string): Promise<EAActivistCode | null> {
    const needle = name.trim().toLowerCase()
    if (!needle) return null

    const result = await this.listActivistCodes()
    const items = result.items ?? []
    const exact = items.find((item) => {
      const label = (item.name ?? item.activistCodeName ?? '').trim().toLowerCase()
      return label === needle
    })
    if (exact) return exact

    return (
      items.find((item) => {
        const label = (item.name ?? item.activistCodeName ?? '').trim().toLowerCase()
        return label.includes(needle)
      }) ?? null
    )
  }

  async listPeopleByActivistCode(
    activistCodeId: number,
    limit = 100
  ): Promise<{ items: EAFindResult[]; count: number; queryStyle: string }> {
    const attempts: Array<{ label: string; params: Record<string, string> }> = [
      {
        label: 'activistCodeId query param',
        params: { activistCodeId: String(activistCodeId), $top: String(limit) },
      },
      {
        label: 'activistCodeIds query param',
        params: { activistCodeIds: String(activistCodeId), $top: String(limit) },
      },
      {
        label: 'OData filter on activistCodeId',
        params: { $filter: `activistCodeId eq ${activistCodeId}`, $top: String(limit) },
      },
      {
        label: 'OData any() filter on activistCodes',
        params: {
          $filter: `activistCodes/any(code:code/activistCodeId eq ${activistCodeId})`,
          $top: String(limit),
        },
      },
    ]

    const failures: string[] = []

    for (const attempt of attempts) {
      try {
        const result = await this.request<{ items: EAFindResult[]; count: number }>(
          'GET',
          '/people',
          undefined,
          attempt.params
        )
        return {
          items: result.items ?? [],
          count: result.count ?? result.items?.length ?? 0,
          queryStyle: attempt.label,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${attempt.label}: ${message}`)
      }
    }

    throw new Error(
      'Unable to list people by activist code with the current EveryAction configuration. ' +
      `Tried: ${failures.join(' | ')}`
    )
  }

  async getContactSummary(vanId: number): Promise<{
    person: EAPerson
    recentNotes: EANote[]
  }> {
    const [person, notes] = await Promise.all([
      this.getPerson(vanId),
      this.getNotes(vanId),
    ])
    return { person, recentNotes: notes.items.slice(0, 5) }
  }

  async upsertPerson(data: {
    firstName: string
    lastName: string
    email?: string
    phone?: string
    employer?: string
  }): Promise<{ vanId: number; isDuplicate: boolean }> {
    const payload: Record<string, unknown> = {
      firstName: data.firstName,
      lastName: data.lastName,
    }

    if (data.email) {
      payload.emails = [{ email: data.email, isPrimary: true }]
    }

    if (data.phone) {
      payload.phones = [{ phoneNumber: data.phone, phoneType: 'C', isPreferred: true }]
    }

    if (data.employer) {
      payload.employer = data.employer
    }

    return this.request<{ vanId: number; isDuplicate: boolean }>(
      'POST',
      '/people/findOrCreate',
      payload
    )
  }
}
