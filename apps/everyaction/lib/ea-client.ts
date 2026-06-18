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
  middleName?: string | null
  prefix?: string | null
  suffix?: string | null
  nickname?: string | null
  emails?: Array<{ email: string; isPrimary: boolean; type?: string }>
  phones?: Array<{ phoneNumber: string; phoneType: string; isPrimary?: boolean }>
  addresses?: Array<{
    addressLine1: string | null
    addressLine2?: string | null
    city: string | null
    stateOrProvince: string | null
    zipOrPostalCode: string | null
    isPrimary: boolean
  }>
  employer?: string | null
  occupation?: string | null
  website?: string | null
  bio?: string | null
}

export interface EACustomField {
  customFieldId: number
  customFieldGroupId?: number
  name?: string | null
  customFieldName?: string | null
  type?: string | null
  availableValues?: Array<{ id: number; name: string }>
}

export interface EACustomFieldValue {
  customFieldId: number
  customFieldGroupId?: number
  assignedValue?: string | null
}

export interface EAContact {
  dateCanvassed: string
  contactTypeId: number
  inputTypeId: number
  notes?: Array<{ text: string; isViewRestricted?: boolean }>
  resultCodeId?: number | null
}

export interface EAContactHistory {
  contactTypeId?: number
  dateCanvassed?: string
  inputTypeId?: number
  resultCodeId?: number | null
}

export interface EANote {
  noteId?: number
  text: string
  isViewRestricted?: boolean
  createdByName?: string
  dateCreated?: string   // legacy field name (may not be returned)
  createdDate?: string   // EA actually returns this casing
  category?: { noteCategoryId?: number; name?: string | null } | null
  contactHistory?: EAContactHistory | null
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

export interface EAInputType {
  inputTypeId: number
  name?: string | null
  inputTypeName?: string | null
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
// EveryAction's "API" input type. contactHistory.inputTypeId defaults to this.
const DEFAULT_INPUT_TYPE_API = 11

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

/**
 * EveryAction's "supporting list" endpoints (contactTypes, resultCodes,
 * inputTypes, ...) return a BARE JSON array, not the paginated
 * `{ items, count }` envelope that /people and /activistCodes use. Normalize
 * both shapes so callers can always read `.items`.
 */
function asItems<T>(response: unknown): { items: T[]; count: number } {
  if (Array.isArray(response)) {
    return { items: response as T[], count: response.length }
  }
  const envelope = (response ?? {}) as { items?: T[]; count?: number }
  const items = envelope.items ?? []
  return { items, count: envelope.count ?? items.length }
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
    this.baseUrl = (config.baseUrl ?? 'https://api.securevan.com').replace(/\/$/, '')
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
    // EA omits emails/phones/addresses unless explicitly expanded.
    return this.request<EAPerson>('GET', `/people/${vanId}`, undefined, {
      $expand: 'emails,phones,addresses',
    })
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

  /**
   * Record an interaction in a person's contact history.
   *
   * This mirrors EveryAction's "Add contact history" UI form: a Note carries
   * the narrative (text, category, view restriction) AND an attached
   * `contactHistory` object that gives it a contact type + date — which is what
   * makes it show up as a typed interaction (e.g. "Meeting") rather than a
   * plain note. Because it's stored as a note, it is also readable back via
   * GET /people/{vanId}/notes (canvassResponses are write-only).
   *
   * inputTypeId is intentionally omitted: the UI form has no input-type field
   * and EveryAction assigns it server-side. Forcing inputTypeId is what made
   * the earlier /canvassResponses attempts fail with "contactTypeId not valid
   * for the input type provided".
   */
  async logContact(
    vanId: number,
    contactTypeId: number,
    noteText?: string,
    dateCanvassed?: string
  ): Promise<void> {
    await this.logContactFull(vanId, { contactTypeId, dateCanvassed, noteText })
  }

  async logContactFull(vanId: number, params: {
    contactTypeId: number
    contactTypeLabel?: string
    dateCanvassed?: string
    resultCodeId?: number | null
    noteText?: string
    noteCategoryId?: number
    isViewRestricted?: boolean
  }): Promise<EANote> {
    // contactHistory.inputTypeId defaults to 11 (API). If the contact type
    // isn't enabled for API input, the write fails — so resolve a compatible
    // input type up front and fail with a clear message if none exists.
    const inputTypeId = await this.resolveInputTypeForContactType(params.contactTypeId)
    if (inputTypeId == null) {
      const label = params.contactTypeLabel ?? `contact type ${params.contactTypeId}`
      throw new Error(
        `The "${label}" contact type is not enabled for any input type usable via the API. ` +
        `In EveryAction, enable this contact type for the "API" input type (Administration > ` +
        `Contact Types), or choose a contact type that is API-enabled.`
      )
    }

    const contactHistory: Record<string, unknown> = {
      contactTypeId: params.contactTypeId,
      inputTypeId,
      dateCanvassed: params.dateCanvassed ?? new Date().toISOString().split('T')[0],
    }
    if (params.resultCodeId != null) contactHistory.resultCodeId = params.resultCodeId

    // EveryAction requires non-empty note text.
    const text = params.noteText?.trim()
      ? params.noteText
      : `${params.contactTypeLabel ?? 'Contact'} logged`

    const payload: Record<string, unknown> = {
      text,
      isViewRestricted: params.isViewRestricted ?? false,
      contactHistory,
    }
    if (params.noteCategoryId != null) payload.category = { noteCategoryId: params.noteCategoryId }

    return this.request<EANote>('POST', `/people/${vanId}/notes`, payload)
  }

  /**
   * Interaction history = the person's notes that carry a contactHistory
   * attribute (i.e. were logged as contact history, not free-form notes).
   * Contact-type names are resolved so callers see "Meeting" rather than an id.
   */
  async getInteractions(vanId: number): Promise<{ items: EAInteraction[]; count: number }> {
    const [notes, types] = await Promise.all([
      this.getNotes(vanId),
      this.listContactTypes().catch(() => ({ items: [] as EAContactType[], count: 0 })),
    ])
    const typeName = new Map<number, string>()
    for (const t of types.items) {
      const label = t.name ?? t.contactTypeName
      if (t.contactTypeId != null && label) typeName.set(t.contactTypeId, label)
    }

    const items: EAInteraction[] = notes.items
      .filter((n) => n.contactHistory && n.contactHistory.contactTypeId != null)
      .map((n) => {
        const ch = n.contactHistory!
        return {
          dateCanvassed: ch.dateCanvassed ?? n.createdDate ?? n.dateCreated,
          contactTypeId: ch.contactTypeId,
          contactTypeName: ch.contactTypeId != null ? typeName.get(ch.contactTypeId) ?? null : null,
          resultCodeId: ch.resultCodeId ?? null,
          notes: n.text ? [{ text: n.text }] : [],
          createdByName: n.createdByName ?? null,
        }
      })

    return { items, count: items.length }
  }

  async listResultCodes(contactTypeId?: number): Promise<{ items: EAResultCode[]; count: number }> {
    // /canvassResponses/resultCodes returns a bare array, not a paginated envelope.
    const params: Record<string, string> | undefined = contactTypeId
      ? { contactTypeId: String(contactTypeId) }
      : undefined
    const raw = await this.request<unknown>('GET', '/canvassResponses/resultCodes', undefined, params)
    return asItems<EAResultCode>(raw)
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

  async listContactTypes(inputTypeId?: number): Promise<{ items: EAContactType[]; count: number }> {
    // /canvassResponses/contactTypes returns a bare array, not a paginated envelope.
    // Pass inputTypeId to get only the contact types valid for that input type.
    const params = inputTypeId != null ? { inputTypeId: String(inputTypeId) } : undefined
    const raw = await this.request<unknown>('GET', '/canvassResponses/contactTypes', undefined, params)
    return asItems<EAContactType>(raw)
  }

  async listInputTypes(): Promise<{ items: EAInputType[]; count: number }> {
    // /canvassResponses/inputTypes returns a bare array, not a paginated envelope.
    const raw = await this.request<unknown>('GET', '/canvassResponses/inputTypes')
    return asItems<EAInputType>(raw)
  }

  /**
   * Find an input type that the given contact type is valid for, so a contact
   * history write doesn't fail with "contactTypeId not valid for the input
   * type". contactHistory defaults inputTypeId to 11 (API), so we try that
   * first, then fall back to scanning every input type.
   */
  async resolveInputTypeForContactType(contactTypeId: number): Promise<number | undefined> {
    const supports = async (inputTypeId: number) => {
      try {
        const { items } = await this.listContactTypes(inputTypeId)
        return items.some((c) => c.contactTypeId === contactTypeId)
      } catch {
        return false
      }
    }

    if (await supports(DEFAULT_INPUT_TYPE_API)) return DEFAULT_INPUT_TYPE_API

    let inputTypes: EAInputType[] = []
    try {
      inputTypes = (await this.listInputTypes()).items
    } catch {
      return undefined
    }
    for (const it of inputTypes) {
      if (it.inputTypeId == null || it.inputTypeId === DEFAULT_INPUT_TYPE_API) continue
      if (await supports(it.inputTypeId)) return it.inputTypeId
    }
    return undefined
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

  /**
   * Update an existing person. EveryAction does NOT support PATCH on /people;
   * POST /people/{vanId} is the documented update verb (an alias for
   * findOrCreate with the vanId fixed). Contact sub-objects (emails, phones,
   * addresses, customFieldValues) are merged in via this same body — there are
   * no /people/{vanId}/emails-style sub-endpoints.
   */
  async updatePerson(vanId: number, data: {
    firstName?: string
    lastName?: string
    middleName?: string
    suffix?: string
    employer?: string
    occupation?: string
    dateOfBirth?: string
  }): Promise<void> {
    const payload: Record<string, unknown> = {}
    const fields = ['firstName','lastName','middleName','suffix','employer','occupation','dateOfBirth'] as const
    for (const f of fields) {
      if (data[f] !== undefined) payload[f] = data[f]
    }
    await this.request<void>('POST', `/people/${vanId}`, payload)
  }

  async addEmail(vanId: number, email: string, isPrimary = false): Promise<void> {
    await this.request<void>('POST', `/people/${vanId}`, {
      emails: [{ email, isPreferred: isPrimary }],
    })
  }

  async addPhone(vanId: number, phoneNumber: string, phoneType = 'C', isPrimary = false): Promise<void> {
    await this.request<void>('POST', `/people/${vanId}`, {
      phones: [{ phoneNumber, phoneType, isPreferred: isPrimary }],
    })
  }

  async addAddress(vanId: number, address: {
    addressLine1: string
    addressLine2?: string
    city?: string
    stateOrProvince?: string
    zipOrPostalCode?: string
    isPrimary?: boolean
  }): Promise<void> {
    const { isPrimary, ...rest } = address
    await this.request<void>('POST', `/people/${vanId}`, {
      addresses: [{ ...rest, isPreferred: isPrimary ?? false }],
    })
  }

  /**
   * Apply an activist code via a manual canvass response. This is EveryAction's
   * documented path for tagging a person with an activist code; /people/{vanId}/codes
   * is for the separate Code/Tag/SourceCode id space, not activist codes.
   */
  async applyActivistCode(vanId: number, activistCodeId: number): Promise<void> {
    await this.request<void>('POST', `/people/${vanId}/canvassResponses`, {
      canvassContext: { inputTypeId: INPUT_TYPE_MANUAL },
      responses: [{ type: 'ActivistCode', action: 'Apply', activistCodeId }],
    })
  }

  async removeActivistCode(vanId: number, activistCodeId: number): Promise<void> {
    await this.request<void>('POST', `/people/${vanId}/canvassResponses`, {
      canvassContext: { inputTypeId: INPUT_TYPE_MANUAL },
      responses: [{ type: 'ActivistCode', action: 'Remove', activistCodeId }],
    })
  }

  async listContactActivistCodes(vanId: number): Promise<{ items: Array<{ activistCodeId: number; activistCodeName: string; dateCreated?: string }> }> {
    return this.request('GET', `/people/${vanId}/activistCodes`)
  }

  /** Merge sourceVanId INTO targetVanId. The source record (URL) is deleted; the target (body) survives. */
  async mergeInto(sourceVanId: number, targetVanId: number): Promise<void> {
    await this.request<void>('PUT', `/people/${sourceVanId}/mergeInto`, { vanId: targetVanId })
  }

  async listCustomFields(): Promise<{ items: EACustomField[] }> {
    return this.request<{ items: EACustomField[] }>('GET', '/customFields', undefined, { $top: '200' })
  }

  async getCustomFieldValues(vanId: number): Promise<{ items: EACustomFieldValue[] }> {
    const person = await this.request<{ customFieldValues?: EACustomFieldValue[] }>(
      'GET', `/people/${vanId}`, undefined, { $expand: 'customFields' }
    )
    return { items: person.customFieldValues ?? [] }
  }

  async setCustomField(vanId: number, customFieldId: number, value: string): Promise<void> {
    await this.request<void>('POST', `/people/${vanId}`, {
      customFieldValues: [{ customFieldId, assignedValue: value }],
    })
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
