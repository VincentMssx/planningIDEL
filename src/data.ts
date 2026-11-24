import { createClient } from '@supabase/supabase-js'

const { VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: key } = import.meta.env

export function configuredClient() {
  try {
    return url && key ? createClient(url, key, { auth: { detectSessionInUrl: false } }) : null
  } catch {
    return null
  }
}

export type Client = NonNullable<ReturnType<typeof configuredClient>>
export type AccountState = {
  active: boolean; must_change_password: boolean; operator?: boolean; verified?: boolean;
  operator_session_fresh?: boolean; operator_factor_id?: string | null;
}

export async function readAccount(db: Client) {
  const { data, error } = await db.rpc('account_state')
  if (error) throw error
  return data as AccountState
}

export async function canReadPlanning(db: Client, id: string) {
  const { data, error } = await db.from('members').select('id').eq('id', id).maybeSingle()
  if (error) throw error
  return data?.id === id
}
export type Tour = 1 | 2
export type Member = { id: string; name: string; active: boolean }
export type Assignment = { day: string; tour: Tour; member_id: string | null; version: number }
export const assigned = (row: Assignment | undefined): row is Assignment & { member_id: string } => !!row?.member_id
export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn' | 'obsolete'
export type Proposal = { id: string; author_id: string; status: ProposalStatus; created_at: string; expires_on: string }
export type Line = { proposal_id: string; day: string; tour: Tour; before_id: string; after_id: string; before_version: number }
export type Vote = { proposal_id: string; member_id: string; approve: boolean; created_at: string }
export const REFUSAL_REASONS = {
  unavailable: 'Indisponible',
  schedule_conflict: 'Conflit de planning',
  keep_schedule: 'Conserver le planning actuel',
} as const
export type RefusalReason = keyof typeof REFUSAL_REASONS
export const isRefusalReason = (reason: unknown): reason is RefusalReason =>
  typeof reason === 'string' && Object.hasOwn(REFUSAL_REASONS, reason)

export type AuditDetails = Record<string, unknown> & {
  lines?: Line[]
  event_actor_id?: string | null
  proposal_created_at?: string | null
}
export type Audit = { id: string; kind: string; actor_id: string | null; proposal_id: string | null; days: string[]; details: AuditDetails; created_at: string }
export type Snapshot = { members: Member[]; assignments: Assignment[]; proposals: Proposal[]; lines: Line[]; votes: Vote[] }

export const FIRST_DAY = '2027-01-01'
export const LAST_DAY = '2027-06-30'
export const PARIS = 'Europe/Paris'
const parisDay = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, year: 'numeric', month: '2-digit', day: '2-digit' })
const fullDay = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeZone: 'UTC' })
const shortDay = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const eventTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: PARIS })

export function todayInParis(now = new Date()) {
  const parts = parisDay.formatToParts(now)
  return ['year', 'month', 'day'].map((key) => parts.find((p) => p.type === key)?.value).join('-')
}
export function defaultMonth(today: string) {
  return today < FIRST_DAY ? 0 : today > LAST_DAY ? 5 : Number(today.slice(5, 7)) - 1
}
export function dayKey(month: number, day: number) {
  return new Date(Date.UTC(2027, month, day)).toISOString().slice(0, 10)
}
export const dayLabel = (day: string) => fullDay.format(new Date(`${day}T00:00:00Z`))
export const shortDayLabel = (day: string) => shortDay.format(new Date(`${day}T00:00:00Z`))
export const timeLabel = (stamp: string) => eventTime.format(new Date(stamp))

export const MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin']
export const PEOPLE = [
  { name: 'Linda', code: 'L', color: 'linda', tour: 1 },
  { name: 'Julie', code: 'J', color: 'julie', tour: 1 },
  { name: 'Lucie', code: 'Lu', color: 'lucie', tour: 2 },
  { name: 'Fanny', code: 'F', color: 'fanny', tour: 2 },
] as const

export function slot(day: string, tour: Tour) {
  return `${day}/${tour}`
}
export const effectiveStatus = (proposal: Proposal, today: string) =>
  proposal.status === 'pending' && proposal.expires_on <= today ? 'expired' : proposal.status

export const STATUS = {
  pending: 'En attente', accepted: 'Acceptée', rejected: 'Refusée',
  withdrawn: 'Retirée', obsolete: 'Obsolète', expired: 'Expirée',
}

const CHUNK = 200

async function readAll<T>(query: (start: number, end: number) => PromiseLike<{ data: T[] | null; error: unknown }>) {
  const rows: T[] = []
  for (let start = 0; ; start += CHUNK) {
    const { data, error } = await query(start, start + CHUNK - 1)
    if (error) throw error
    if (!data) throw new Error('Réponse vide')
    rows.push(...data)
    if (data.length < CHUNK) return rows
  }
}

export async function readSnapshot(db: Client, day: string | null = null): Promise<Snapshot> {
  const [members, assignments, pending, dayLines] = await Promise.all([
    readAll<Member>((from, to) => db.from('members').select('id,name,active').order('id').range(from, to)),
    // A single request reads the complete official semester without splitting a transaction across pages.
    (async () => {
      const { data, error } = await db.from('assignments').select('day,tour,member_id,version').gte('day', FIRST_DAY).lte('day', LAST_DAY).order('day').order('tour').limit(362)
      if (error) throw error
      return data as Assignment[]
    })(),
    readAll<Proposal>((from, to) => db.from('proposals').select('id,author_id,status,created_at,expires_on').eq('status', 'pending').gt('expires_on', todayInParis()).order('id').range(from, to)),
    day ? readAll<Line>((from, to) => db.from('proposal_lines').select('proposal_id,day,tour,before_id,after_id,before_version').eq('day', day).order('proposal_id').order('tour').range(from, to)) : [],
  ])
  const ids = [...new Set([...pending.map((p) => p.id), ...dayLines.map((l) => l.proposal_id)])]
  const groups = await Promise.all(Array.from({ length: Math.ceil(ids.length / 40) }, async (_, index) => {
    const batch = ids.slice(index * 40, (index + 1) * 40)
    const [proposals, lines, votes] = await Promise.all([
      readAll<Proposal>((from, to) => db.from('proposals').select('id,author_id,status,created_at,expires_on').in('id', batch).order('id').range(from, to)),
      readAll<Line>((from, to) => db.from('proposal_lines').select('proposal_id,day,tour,before_id,after_id,before_version').in('proposal_id', batch).order('proposal_id').order('day').order('tour').range(from, to)),
      readAll<Vote>((from, to) => db.from('votes').select('proposal_id,member_id,approve,created_at').in('proposal_id', batch).order('proposal_id').order('member_id').range(from, to)),
    ])
    return { proposals, lines, votes }
  }))
  return { members, assignments, proposals: groups.flatMap((g) => g.proposals), lines: groups.flatMap((g) => g.lines), votes: groups.flatMap((g) => g.votes) }
}

export const PAGE_SIZE = 20
export type HistoryFilter = 'all' | 'accepted' | 'rejected'

export async function readHistory(db: Client, day: string, cursor?: Audit, history: HistoryFilter = 'all') {
  let query = db.from('grouped_history').select('id,kind,actor_id,proposal_id,days,details,created_at')
  if (day) query = query.contains('days', [day])
  if (history !== 'all') query = query.eq('kind', history)
  if (cursor) query = query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`)
  const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(PAGE_SIZE + 1)
  if (error) throw error
  const rows = data as Audit[]
  return { rows: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE }
}
