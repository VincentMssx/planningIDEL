import { Fragment, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  canReadPlanning, readAccount, readFeed, readSnapshot, todayInParis, defaultMonth, dayKey,
  dayLabel, shortDayLabel, timeLabel, effectiveStatus, slot, FIRST_DAY, LAST_DAY, MONTHS, PARIS, PEOPLE, STATUS,
  type Audit, type Client, type HistoryFilter, type Message, type Snapshot, type Tour,
} from './data'

type Props = { db: Client; id: string; token: string; signOut: () => void; accessLost: () => void }
type Feed = Awaited<ReturnType<typeof readFeed>>
type FeedTable = 'audit' | 'messages'
type View = 'calendar' | FeedTable
const tabs = [
  { view: 'calendar', label: 'Planning', icon: 'M3 6h18v15H3z M3 10h18 M7 3v5 M17 3v5' },
  { view: 'audit', label: 'Historique', icon: 'M4 11a8 8 0 1 1 2 7 M4 5v6h6 M12 8v5l3 2' },
  { view: 'messages', label: 'Chat', icon: 'M3 4h18v12H9l-6 4z M7 9h10 M7 12h6' },
] as const
const tours = [0, 1, 2] as const
const hideRefresh = import.meta.env.DEV || import.meta.env.VITE_HIDE_PLANNING_REFRESH === 'true'
export type WorkspaceSource = {
  today: () => string
  allowed: () => Promise<boolean>
  snapshot: (day: string | null) => Promise<Snapshot>
  feed: (table: FeedTable, day: string, cursor?: Audit | Message, history?: HistoryFilter) => Promise<Feed>
  mutate: (name: string, args: Record<string, unknown>, signal: AbortSignal) => PromiseLike<{ status: number; error: { code: string; message: string } | null }>
}
const weekday = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim']
type PersonLabel = (member: string | null) => string
type Propose = (name: string, args: Record<string, unknown>, onConfirmed?: () => void) => Promise<void>
type ProposalTone = 'action' | 'wait' | 'done' | 'rejected'
const stateMarks = { action: '!', wait: '?', done: '✓', rejected: '×' } satisfies Record<ProposalTone, string>
const historyFilters = [['all', 'Tout'], ['accepted', '✓ Validées'], ['rejected', '× Refusées']] as const

export function Workspace({ db, id, token, signOut, accessLost }: Props) {
  const source: WorkspaceSource = {
    today: todayInParis,
    async allowed() {
      const account = await readAccount(db)
      return account.active && !account.must_change_password && await canReadPlanning(db, id)
    },
    snapshot: (day) => readSnapshot(db, day),
    feed: (table, day, cursor, history) => readFeed(db, table, day, cursor, history),
    mutate: (name, args, signal) => db.rpc(name, args).retry(false).abortSignal(signal),
  }
  return <WorkspaceView {...{ source, id, token, signOut, accessLost }} />
}

export function WorkspaceView({ source, id, token, signOut, accessLost, controls }: Omit<Props, 'db'> & { source: WorkspaceSource; controls?: ReactNode }) {
  const [today, setToday] = useState(source.today)
  const [month, setMonth] = useState(() => defaultMonth(today))
  const [tourFilter, setTourFilter] = useState<(typeof tours)[number]>(0)
  const [nurse, setNurse] = useState('')
  const [selectedDay, setDay] = useState<string | null>(null)
  const [ticket, setTicket] = useState<string | null>(null)
  const [voting, setVoting] = useState(false)
  const [confirmedVotes, setConfirmedVotes] = useState<ReadonlySet<string>>(() => new Set())
  const [refusing, setRefusing] = useState<string | null>(null)
  const [view, setView] = useState<View>('calendar')
  const [filter, setFilter] = useState('')
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all')
  const historyKey = `${historyFilter}/${filter}`
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [feeds, setFeeds] = useState<{ audit?: Feed; messages?: Feed; filter: string }>({ filter: '' })
  const [draft, setDraft] = useState('')
  const [stale, setStale] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [busy, setBusy] = useState(false)
  const [paging, setPaging] = useState(false)
  const [notice, setNotice] = useState('')
  const [unconfirmed, setUnconfirmed] = useState(false)
  const serial = useRef(0)
  const sending = useRef(false)
  const scroll = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDialogElement>(null)
  const voteHeading = useRef<HTMLHeadingElement>(null)

  const open = new Set(snapshot?.proposals.filter((p) => effectiveStatus(p, today) === 'pending').map((p) => p.id))
  const affected = new Set(snapshot?.lines.filter((line) => line.before_id === id || line.after_id === id).map((line) => line.proposal_id))
  const voted = new Set([...confirmedVotes, ...(snapshot?.votes.filter((vote) => vote.member_id === id).map((vote) => vote.proposal_id) ?? [])])
  const queue = snapshot?.proposals.filter((p) => open.has(p.id) && affected.has(p.id) && !voted.has(p.id))
    .sort((a, b) => a.expires_on.localeCompare(b.expires_on) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)) ?? []
  const toVote = new Set(queue.map((p) => p.id))
  const nextVote = queue[0]
  const activeVote = voting ? nextVote : undefined
  const activeVoteId = activeVote?.id
  const day = activeVote?.expires_on ?? selectedDay

  async function refresh() {
    const request = ++serial.current
    setRefreshing(true)
    setPaging(false)
    setToday(source.today())
    try {
      if (!await source.allowed()) {
        if (request === serial.current) accessLost()
        return
      }
      if (request !== serial.current) return
      const [planning, audit, messages] = await Promise.all([
        source.snapshot(selectedDay),
        view === 'audit' ? source.feed('audit', filter, undefined, historyFilter) : undefined,
        view === 'messages' ? source.feed('messages', '') : undefined,
      ])
      if (request !== serial.current) return
      // RLS can silently return empty rows if authorization changed during the reads.
      if (!planning.members.some((m) => m.id === id && m.active)) { accessLost(); return }
      setSnapshot(planning)
      setFeeds((old) => ({ filter: historyKey, audit: refreshFeed(old.filter === historyKey ? old.audit : undefined, audit), messages: refreshFeed(old.messages, messages) }))
      setStale(false)
      setUnconfirmed(false)
    } catch (error) {
      if (request !== serial.current) return
      if (['42501', 'PGRST301', 'PGRST303'].includes((error as { code?: string })?.code ?? '')) { accessLost(); return }
      setStale(true)
    } finally {
      if (request === serial.current) setRefreshing(false)
    }
  }

  const refreshFromEffect = useEffectEvent(refresh)
  useEffect(() => { void refreshFromEffect() }, [token, selectedDay, view, filter, historyFilter])
  useEffect(() => {
    function visible() { if (document.visibilityState === 'visible') void refreshFromEffect() }
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('online', visible)
    return () => {
      serial.current++
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('online', visible)
    }
  }, [])

  function jumpMonth(index: number) {
    const container = scroll.current
    const section = container?.querySelector(`[data-month="${index}"]`)
    if (container && section) container.scrollTop = index === 0 ? 0 : container.scrollTop + section.getBoundingClientRect().top - container.getBoundingClientRect().top
    setMonth(index)
  }

  const restoreMonth = useEffectEvent(() => jumpMonth(month))
  const calendarVisible = !!snapshot && view === 'calendar'
  useEffect(() => { if (calendarVisible) restoreMonth() }, [calendarVisible])

  const sheetVisible = !!snapshot && (view === 'calendar' || view === 'audit' || (view === 'messages' && !!ticket)) && (voting || day !== null)
  useLayoutEffect(() => {
    if (sheetVisible && !sheet.current?.open) sheet.current?.showModal()
  }, [sheetVisible])
  useLayoutEffect(() => {
    if (!activeVoteId) return
    if (sheet.current) sheet.current.scrollTop = 0
    voteHeading.current?.focus({ preventScroll: true })
  }, [activeVoteId])
  useLayoutEffect(() => {
    if (voting && !nextVote) {
      sheet.current?.close()
      setVoting(false)
      setNotice('Plus aucun vote à faire.')
    }
  }, [voting, nextVote])

  async function mutate(name: string, args: Record<string, unknown>, onConfirmed?: () => void) {
    if (sending.current || refreshing || stale || unconfirmed) return
    sending.current = true
    setBusy(true)
    setNotice('')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15_000)
    try {
      const { error, status } = await source.mutate(name, args, controller.signal)
      if (error) {
        if (status === 0 || status === 408 || status >= 500) throw error
        setNotice(status === 400 && error.code === '22023' ? error.message : 'Action refusée par le serveur.')
      } else {
        onConfirmed?.()
        if (name !== 'cast_vote') setNotice('Action enregistrée.')
      }
    } catch {
      setUnconfirmed(true)
      setNotice('Action non confirmée. Vérifiez les données actualisées avant toute nouvelle tentative.')
    } finally {
      window.clearTimeout(timeout)
      await refresh()
      sending.current = false
      setBusy(false)
    }
  }

  async function more(table: FeedTable, feed: Feed) {
    if (paging || refreshing || stale) return
    const request = serial.current
    setPaging(true)
    try {
      const next = await source.feed(table, table === 'audit' ? filter : '', feed.rows.at(-1), historyFilter)
      if (request !== serial.current) return
      setFeeds((old) => ({ ...old, [table]: { ...next, rows: [...feed.rows, ...next.rows] } }))
    } catch {
      if (request === serial.current) { setNotice('Impossible de lire la page suivante.'); await refresh() }
    } finally { if (request === serial.current) setPaging(false) }
  }

  const person = (member: string | null) => snapshot?.members.find((m) => m.id === member)?.name ?? (member ? 'Membre' : 'Import')
  const bySlot = new Map(snapshot?.assignments.map((a) => [slot(a.day, a.tour), a]))
  const openSlots = new Set(snapshot?.lines.filter((l) => open.has(l.proposal_id)).map((l) => slot(l.day, l.tour)))
  const markedDays = new Set(snapshot?.lines.filter((l) => open.has(l.proposal_id) && affected.has(l.proposal_id)).map((l) => l.day))
  const voteDays = new Set(snapshot?.lines.filter((l) => toVote.has(l.proposal_id)).map((l) => l.day))
  const dayProposals = activeVote ? [activeVote] : snapshot?.proposals.filter((p) => (!ticket || p.id === ticket) && snapshot.lines.some((l) => l.day === day && l.proposal_id === p.id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)) ?? []
  const locked = busy || refreshing || stale || unconfirmed
  const history = feeds.filter === historyKey ? feeds.audit : undefined

  function openDay(date: string, proposalId?: string) {
    setVoting(false)
    setDay(date)
    setTicket(proposalId ?? null)
    setRefusing(null)
    setNotice('')
  }

  function castVote(proposalId: string, approve: boolean, reason?: string) {
    void mutate('cast_vote', { p_proposal_id: proposalId, p_approve: approve, ...(reason ? { p_reason: reason } : {}) }, () => {
      setRefusing(null)
      setConfirmedVotes((previous) => new Set(previous).add(proposalId))
      if (!voting && sheet.current?.open && queue.some((p) => p.id !== proposalId)) setVoting(true)
    })
  }

  function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const body = draft.trim()
    if (body) void mutate('post_message', { p_body: body }, () => setDraft(''))
  }

  return <main className="idel-app">
    {controls}
    <header className="topbar">
      <h1 className="brand"><span className="brand-dot" aria-hidden="true" />Tournées IDEL</h1>
      <div className="top-actions">
        <span className="account-chip">{person(id)}</span>
        {!hideRefresh && <button className="icon-button" aria-label="Actualiser" title="Actualiser" disabled={busy || refreshing} onClick={() => void refresh()}><Icon path="M20 5v6h-6 M20 11a8 8 0 1 0-2 7" /></button>}
        {!controls && <button className="icon-button" aria-label="Déconnexion" title="Déconnexion" onClick={signOut}><Icon path="M10 4H4v16h6 M8 12h13 M17 8l4 4-4 4" /></button>}
      </div>
    </header>
    {stale && <p className="notice" role="alert">{snapshot ? 'Données non actualisées : dernière lecture disponible.' : 'Lecture indisponible.'} Vérifiez la connexion, puis {hideRefresh ? 'rechargez la page' : 'actualisez'}.</p>}
    {notice && !sheetVisible && <p className="notice" role="status">{notice}</p>}
    {!snapshot && !stale && <p role="status">Lecture de l’espace privé…</p>}
    {nextVote && (view === 'calendar' || view === 'audit') && <button className="vote-callout" disabled={busy} onClick={() => {
      if (view === 'calendar') jumpMonth(Number(nextVote.expires_on.slice(5, 7)) - 1)
      setDay(null)
      setTicket(null)
      setRefusing(null)
      setNotice('')
      setVoting(true)
    }}>
      <span className="vote-callout-icon" aria-hidden="true">!</span>
      <span><strong>{toVote.size === 1 ? '1 vote à faire' : `${toVote.size} votes à faire`}</strong><small>Prochaine demande : {shortDayLabel(nextVote.expires_on)}</small></span>
      <span aria-hidden="true">›</span>
    </button>}
    {snapshot && view === 'calendar' && <div className="planning-view">
      <div className="planning-controls">
        <div className="month-jump" role="group" aria-label="Mois">{MONTHS.map((name, index) =>
          <button key={name} aria-label={name} aria-pressed={month === index} onClick={() => jumpMonth(index)}>{['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin'][index]}</button>)}</div>
        <div className="filters-bar">
          <div className="tour-segment" role="group" aria-label="Tournées">{tours.map((tour) =>
            <button key={tour} aria-pressed={tourFilter === tour} onClick={() => setTourFilter(tour)}>{tour ? `Tournée ${tour}` : 'Les deux tournées'}</button>)}</div>
          <div className="nurse-filters" role="group" aria-label="Infirmières">
            <button aria-pressed={!nurse} onClick={() => setNurse('')}>Toutes</button>
            {PEOPLE.map((p) => <button key={p.code} className={p.color} aria-label={p.name} title={p.name} aria-pressed={nurse === p.name} onClick={() => setNurse(nurse === p.name ? '' : p.name)}>{p.code}</button>)}
          </div>
        </div>
        <div className="weekdays" aria-hidden="true">{weekday.map((label) => <span key={label}>{label}</span>)}</div>
      </div>
      <div className="planning-scroll" ref={scroll} onScroll={(event) => {
        const container = event.currentTarget
        const top = container.getBoundingClientRect().top
        const blocks = Array.from(container.querySelectorAll('[data-month]'))
        const active = blocks.findIndex((block) => block.getBoundingClientRect().bottom > top + 24)
        if (active >= 0) setMonth(active)
      }}>
        {!snapshot.assignments.length && <p className="notice">Aucun planning officiel n’a été importé.</p>}
        {MONTHS.map((name, index) => {
          const monthDays = new Date(Date.UTC(2027, index + 1, 0)).getUTCDate()
          const offset = (new Date(Date.UTC(2027, index, 1)).getUTCDay() + 6) % 7
          return <section className="month-block" key={name} data-month={index} aria-labelledby={`month-${index}`}>
            <h2 className="month-head" id={`month-${index}`}>{name} <span>2027</span></h2>
            <div className="calendar">
          {Array.from({ length: offset }, (_, i) => <span key={`gap-${i}`} />)}
          {Array.from({ length: monthDays }, (_, i) => {
            const date = dayKey(index, i + 1)
            const changed = ([1, 2] as const).some((tour) => (tourFilter === 0 || tour === tourFilter) && (bySlot.get(slot(date, tour))?.version ?? 0) > 1)
            const state = voteDays.has(date) ? 'action' : markedDays.has(date) ? 'wait' : changed ? 'done' : null
            const stateLabel = state === 'action' ? 'vote à faire' : state === 'wait' ? 'demande en attente' : state === 'done' ? 'modification validée' : ''
            const codes = ([1, 2] as const).map((tour) => {
              const a = bySlot.get(slot(date, tour))
              return a && PEOPLE.find((p) => p.name === person(a.member_id))
            })
            return <button key={date} className={`day${state ? ` day-${state} tone-${state}` : ''}`} aria-pressed={day === date} aria-current={today === date ? 'date' : undefined}
              aria-label={`${dayLabel(date)}, tournée 1 : ${codes[0]?.name ?? 'non attribuée'}, tournée 2 : ${codes[1]?.name ?? 'non attribuée'}${stateLabel ? `, ${stateLabel}` : ''}`}
              disabled={busy} onClick={() => openDay(date)}>
              <span className="day-number">{i + 1}{state && <span className="state-mark" aria-hidden="true">{stateMarks[state]}</span>}</span>
              {codes.map((p, index) => <span key={index} hidden={tourFilter !== 0 && tourFilter !== index + 1} className={`code ${p?.color ?? 'unassigned'}${nurse && p?.name !== nurse ? ' slot-dimmed' : ''}`} aria-hidden="true">{p?.code ?? '–'}</span>)}
            </button>
          })}
            </div>
          </section>
        })}
      </div>
    </div>}
    {sheetVisible && <dialog className={`day-sheet${voting ? ' vote-sheet' : ''}`} ref={sheet} aria-labelledby="day-heading" aria-describedby={activeVote ? 'vote-progress' : undefined} onClose={() => { setDay(null); setVoting(false); setTicket(null) }}
        onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close() }}>
        <section className="day-detail">
          <div className="sheet-handle" aria-hidden="true" />
          <div className="sheet-header">
            <h2 id="day-heading" ref={voteHeading} tabIndex={voting ? -1 : undefined}>{day ? dayLabel(day) : 'Votes à faire'}</h2>
            <div className="sheet-links">
              {view === 'calendar' && !voting && day && <button className="link-pill" disabled={busy} onClick={() => { setHistoryFilter('all'); setFilter(day); sheet.current?.close(); setDay(null); setView('audit') }}>Historique <span aria-hidden="true">↗</span></button>}
              <button className="icon-button close-sheet" aria-label="Fermer" autoFocus onClick={() => sheet.current?.close()}><Icon path="M6 6l12 12 M18 6L6 18" /></button>
            </div>
          </div>
          {activeVote && <p id="vote-progress" className="vote-progress" role="status">{queue.length === 1 ? 'Dernier vote à faire' : `${queue.length} votes à faire`}</p>}
          {!voting && !ticket && day && <DayAssignments key={day} {...{ day, today, snapshot, bySlot, openSlots, locked, mutate, person }} />}
          {ticket && !dayProposals.length && <p role="status">{refreshing ? 'Lecture de la demande…' : 'Cette demande n’est pas disponible.'}</p>}
          {notice && <p className="notice" role="status">{notice}</p>}
          {stale && <p className="notice" role="alert">Dernière lecture disponible. {hideRefresh ? 'Rechargez la page pour actualiser.' : 'Fermez la fiche pour actualiser.'}</p>}
          {dayProposals.map((p) => {
            const status = effectiveStatus(p, today)
            const votes = snapshot.votes.filter((v) => v.proposal_id === p.id)
            const lines = snapshot.lines.filter((l) => l.proposal_id === p.id)
            const participants = [...new Set(lines.flatMap((l) => [l.before_id, l.after_id]))]
            const myVote = votes.find((v) => v.member_id === id)
            const canVote = status === 'pending' && participants.includes(id) && !myVote
            const tone = status === 'pending' ? (toVote.has(p.id) ? 'action' : 'wait') : status === 'accepted' ? 'done' : status === 'rejected' ? 'rejected' : undefined
            return <article className={`proposal${tone ? ` tone-${tone}` : ''}`} key={p.id}>
              <div className="proposal-top">
                <ChangeFlow lines={lines} person={person} />
                {status !== 'pending' && status !== 'accepted' && <span className="decision-badge">{STATUS[status]}</span>}
              </div>
              {toVote.has(p.id) && <span className="decision-badge tone-action">! Ton vote est attendu</span>}
              {status === 'accepted' && <span className="decision-badge decision-accepted tone-done">✓ Planning mis à jour</span>}
              <p className="note">{person(p.author_id)} · {timeLabel(p.created_at)}</p>
              <ul className="votes" aria-label="Votes des personnes concernées">{participants.map((member) => {
                const vote = votes.find((v) => v.member_id === member)
                const waiting = !vote && status === 'pending'
                const label = vote ? (vote.approve ? 'Accord donné' : 'Refus') : waiting ? 'Vote attendu' : 'Sans vote'
                return <li key={member} title={label} className={vote?.approve ? 'vote-yes' : vote || waiting ? 'vote-no' : undefined}>{person(member)}<span className="sr-only"> : {label}</span><span aria-hidden="true"> {vote ? (vote.approve ? '✓' : '×') : waiting ? '?' : '–'}</span></li>
              })}</ul>
              {myVote && participants.includes(id) && <span className="vote-receipt">✓ Vote enregistré</span>}
              {status === 'pending' && refusing !== p.id && (canVote || p.author_id === id) && <div className="proposal-actions">
                {canVote && <><button className="reject" disabled={locked} onClick={() => setRefusing(p.id)}>Refuser</button>
                <button className="primary" disabled={locked} onClick={() => castVote(p.id, true)}>Approuver</button></>}
                {p.author_id === id && <button disabled={locked} onClick={() => void mutate('withdraw_proposal', { p_proposal_id: p.id })}>Retirer</button>}
              </div>}
              {canVote && refusing === p.id && <RefusalForm key={p.id} locked={locked} cancel={() => setRefusing(null)}
                submit={(reason) => castVote(p.id, false, reason)} />}
            </article>
          })}
          {!voting && nextVote && !dayProposals.some((p) => p.id === nextVote.id) && <button className="primary" disabled={locked} onClick={() => { setNotice(''); setRefusing(null); setVoting(true) }}>Vote suivant · {shortDayLabel(nextVote.expires_on)}</button>}
          {day && day <= today && <p className="note">Seules les dates futures peuvent être modifiées.</p>}
        </section>
      </dialog>}
    {snapshot && view === 'audit' && <section className="history-view" aria-labelledby="history-heading">
      <h2 id="history-heading" className="sr-only">Historique des décisions</h2>
      <div className="history-top" role="group" aria-label="Filtrer les décisions">
        {historyFilters.map(([kind, label]) => <button key={kind} className="filter-chip" aria-pressed={kind === historyFilter} onClick={() => setHistoryFilter(kind)}>{label}</button>)}
        {filter && <button className="filter-chip day-filter" aria-label={`Retirer le filtre du ${dayLabel(filter)}`} onClick={() => setFilter('')}>{shortDayLabel(filter)} ×</button>}
      </div>
      <div className="history-scroll" key={historyKey}>
        {!history?.rows.length && <p className="pane-empty" role="status">{refreshing ? 'Lecture en cours…' : 'Aucune décision'}</p>}
        <ol className="history-list">{history?.rows.map((row) => !('body' in row) && <AuditEntry key={row.id} row={row} person={person} day={filter} openDay={openDay}
          pending={!!row.proposal_id && open.has(row.proposal_id)} needsVote={!!row.proposal_id && toVote.has(row.proposal_id)} />)}</ol>
        {history?.more && <button className="load-more" disabled={paging || refreshing || stale} onClick={() => void more('audit', history)}>Afficher les éléments précédents</button>}
      </div>
    </section>}
    {snapshot && view === 'messages' && <ChatPane id={id} today={today} person={person} feed={feeds.messages} draft={draft} setDraft={setDraft} send={send} openTicket={openDay}
      busy={busy} locked={locked} refreshing={refreshing} canPage={!paging && !refreshing && !stale} loadOlder={() => { if (feeds.messages) void more('messages', feeds.messages) }} />}
    <nav className="bottom-nav" aria-label="Espace de travail">
      {tabs.map((tab) => <button key={tab.view}
        aria-current={view === tab.view ? 'page' : undefined} disabled={busy} onClick={() => { setDay(null); if (tab.view === 'audit') setFilter(''); setView(tab.view) }}>
        <Icon path={tab.icon} /><span>{tab.label}</span>
        {tab.view === 'calendar' && toVote.size > 0 && <span className="tab-badge" aria-label={`${toVote.size} demandes à voter`}>{toVote.size}</span>}
      </button>)}
    </nav>
  </main>
}

function Icon({ path }: { path: string }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>
}

function RefusalForm({ locked, submit, cancel }: { locked: boolean; submit: (reason: string) => void; cancel: () => void }) {
  const [reason, setReason] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  return <form className="refusal-form" onSubmit={(event) => { event.preventDefault(); if (!locked && reason.trim()) submit(reason.trim()) }}>
    <label>Motif du refus<textarea ref={input} required maxLength={500} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} aria-describedby="refusal-hint" /></label>
    <p id="refusal-hint" className="note">Le motif sera publié dans le chat du groupe. N’y indique pas de données patient.</p>
    <div className="proposal-actions"><button type="button" onClick={cancel}>Annuler</button><button className="reject" disabled={locked || !reason.trim()}>Confirmer le refus</button></div>
  </form>
}

function DayAssignments({ day, today, snapshot, bySlot, openSlots, locked, mutate, person }: {
  day: string; today: string; snapshot: Snapshot; bySlot: Map<string, Snapshot['assignments'][number]>; openSlots: Set<string>; locked: boolean;
  mutate: Propose; person: PersonLabel;
}) {
  const [expanded, setExpanded] = useState<Tour | null>(null)
  const [exchange, setExchange] = useState(false)
  const [choice, setChoice] = useState('')
  const [preview, setPreview] = useState<{ args: Record<string, unknown>; lines: Snapshot['lines'] } | null>(null)
  function toggle(next: Tour | null) {
    setExpanded(next)
    setExchange(false)
    setChoice('')
    setPreview(null)
  }
  return <ol className="assignments" aria-label="Affectations officielles">{([1, 2] as const).map((tour) => {
    const assignment = bySlot.get(slot(day, tour))
    const current = assignment?.member_id
    const opposite = tour === 1 ? 2 : 1
    const other = bySlot.get(slot(day, opposite))?.member_id
    const pair = snapshot.members.filter((m) => PEOPLE.some((p) => p.name === m.name && p.tour === tour))
    const blocked = openSlots.has(slot(day, tour))
    const editable = !!assignment && day > today && !blocked
    const isOpen = expanded === tour && editable
    const currentName = current ? person(current) : 'Non attribuée'
    const dates = isOpen && pair.some((m) => m.id === current) ? snapshot.assignments.filter((a) =>
      a.tour === tour && a.day !== day && a.day > today && a.member_id !== current && pair.some((m) => m.id === a.member_id)
      && !openSlots.has(slot(a.day, tour)) && bySlot.get(slot(a.day, opposite))?.member_id !== current && other !== a.member_id) : []
    const selected = dates.some((a) => a.day === choice) ? choice : ''
    const row = <><span className="tour-left"><span className="tour-tag">Tournée {tour}</span><strong className={`nurse-chip ${nurseColor(currentName)}`}>{currentName}</strong></span>
      {editable ? <span className="edit-hint">{isOpen ? 'Fermer' : 'Modifier ›'}</span> : blocked ? <span className="note">Demande ouverte</span> : null}</>
    const showPreview = (target: string, swap?: Snapshot['assignments'][number]) => {
      if (!assignment) return
      const line = (before: Snapshot['assignments'][number], after_id: string) => ({ proposal_id: '', day: before.day, tour, before_id: before.member_id, before_version: before.version, after_id })
      setPreview({ args: swap ? { p_other_day: swap.day } : { p_after_id: target }, lines: swap ? [line(assignment, target), line(swap, assignment.member_id)] : [line(assignment, target)] })
    }
    const previewValid = preview?.lines.every((line) => {
      const latest = bySlot.get(slot(line.day, tour))
      return latest?.version === line.before_version && latest?.member_id === line.before_id && !openSlots.has(slot(line.day, tour)) &&
        bySlot.get(slot(line.day, opposite))?.member_id !== line.after_id
    })
    return <li key={tour} className="tour-card">
      {editable ? <button className="tour-row" type="button" aria-expanded={isOpen} onClick={() => toggle(isOpen ? null : tour)}>{row}</button> : <div className="tour-row">{row}</div>}
      {isOpen && <div className="inline-picker">
        {preview ? <section className="change-preview" aria-labelledby="change-preview-heading">
          <h3 id="change-preview-heading">Confirmer la demande</h3>
          <ChangeFlow lines={preview.lines} person={person} />
           <p className="note">{previewValid ? 'Les deux personnes concernées devront ensuite donner leur accord.' : 'Le planning a changé. Annule et choisis à nouveau le créneau.'}</p>
          <div className="proposal-actions">
            <button type="button" onClick={() => setPreview(null)}>Annuler</button>
            <button type="button" className="primary" disabled={locked || !previewValid} onClick={() => void mutate('create_proposal', { p_day: day, p_tour: tour, ...preview.args }, () => toggle(null))}>Confirmer l’envoi</button>
          </div>
        </section> : <>
        <div className="picker-grid">{PEOPLE.map((p) => {
          const member = pair.find((m) => m.name === p.name)
          const isCurrent = currentName === p.name
          return <button key={p.code} className="pick-nurse" type="button" disabled={locked || !member || isCurrent || member.id === other}
            onClick={() => { if (member) showPreview(member.id) }}>
            <span>{p.name}</span><span className={`nurse-chip ${p.color}`}>{isCurrent ? 'Actuelle' : p.code}</span>
          </button>
        })}</div>
        <button type="button" className="swap-button" aria-expanded={exchange} onClick={() => setExchange(!exchange)}>⇄ Échanger avec une autre date</button>
        {exchange && (dates.length ? <form className="swap-form" onSubmit={(event) => {
          event.preventDefault()
          const swap = dates.find((a) => a.day === selected)
          if (!locked && swap) showPreview(swap.member_id, swap)
        }}>
          <label>Autre date de la tournée {tour}<select required value={selected} onChange={(event) => setChoice(event.target.value)}>
            <option value="">Choisir une date…</option>{dates.map((a) => <option key={a.day} value={a.day}>{shortDayLabel(a.day)} · {person(a.member_id)}</option>)}
          </select></label>
          <button className="primary" disabled={locked || !selected}>Proposer l’échange</button>
        </form> : <p className="note">Aucune autre date compatible pour cette tournée.</p>)}
        </>}
      </div>}
    </li>
  })}</ol>
}

const nurseColor = (name: string) => PEOPLE.find((p) => p.name === name)?.color ?? 'unassigned'

function ChangeFlow({ lines, person }: { lines: Snapshot['lines']; person: PersonLabel }) {
  return <span className="change-flow">{lines.map((line) => <span className="change-line" key={slot(line.day, line.tour)}>
    <span className="tour-tag">Tournée {line.tour}{lines.length > 1 ? ` · ${shortDayLabel(line.day)}` : ''}</span>
    {[person(line.before_id), person(line.after_id)].map((name, i) => <span className="change-person" key={i}>
      {i === 1 && <span className="change-arrow">→</span>}<span className={`nurse-chip ${nurseColor(name)}`}>{name}</span>
    </span>)}
  </span>)}</span>
}

const auditBadges: Record<string, string> = { import: 'Import', proposal: 'Demande créée', withdrawn: 'Retirée', accepted: '✓ Validée', rejected: '× Refusée', obsolete: 'Obsolète' }

function AuditEntry({ row, person, day, openDay, pending, needsVote }: { row: Audit; person: PersonLabel; day: string; openDay: (day: string, proposalId?: string) => void; pending: boolean; needsVote: boolean }) {
  const lines = Array.isArray(row.details.lines) ? row.details.lines as Snapshot['lines'] : []
  const date = row.kind === 'import' ? undefined : (row.days.includes(day) ? day : row.days[0])
  const month = date ? MONTHS[Number(date.slice(5, 7)) - 1]?.slice(0, 3) : 'INIT'
  const tone = row.kind === 'accepted' ? 'done' : row.kind === 'rejected' ? 'rejected' : pending ? (needsVote ? 'action' : 'wait') : undefined
  const content = <>
    <span className="history-date" aria-label={date ? dayLabel(date) : undefined}><strong>{date ? Number(date.slice(8)) : '↓'}</strong><span>{month}</span></span>
    <span className="history-flow">
      {row.kind === 'import' ? <span className="change-line"><strong>Planning officiel</strong><span className="tour-tag">{String(row.details.slot_count)} créneaux</span></span>
        : <>{lines.length > 0 && <ChangeFlow lines={lines} person={person} />}<span className="note">Demandée par {person(row.actor_id)}</span></>}
    </span>
    <span className="history-meta">
      <span className={`decision-badge decision-${row.kind}`}>{row.kind === 'proposal' && pending ? (needsVote ? '! À voter' : '?') : row.kind === 'vote' ? (row.details.approve ? 'Vote oui' : 'Vote non') : auditBadges[row.kind] ?? row.kind}
        {row.kind === 'proposal' && tone === 'wait' && <span className="sr-only"> En attente</span>}
      </span>
      <time dateTime={row.created_at}>{timeLabel(row.created_at)}</time>
    </span>
  </>
  const className = `history-card history-${row.kind}${tone ? ` tone-${tone}` : ''}`
  return <li>{date && date >= FIRST_DAY && date <= LAST_DAY ? <button className={className} onClick={() => openDay(date, row.proposal_id ?? undefined)}>{content}</button> : <div className={className}>{content}</div>}</li>
}

function refreshFeed(previous?: Feed, latest?: Feed) {
  if (!latest) return previous
  const oldest = latest.rows.at(-1)
  const overlap = oldest ? previous?.rows.findIndex((row) => row.id === oldest.id) ?? -1 : -1
  if (!previous || !latest.more || overlap < 0) return latest
  // A newly closed ticket can move from an older history page to the first page.
  const key = (row: Audit | Message) => 'kind' in row && row.proposal_id ? row.proposal_id : row.id
  const seen = new Set(latest.rows.map(key))
  return { rows: [...latest.rows, ...previous.rows.slice(overlap + 1).filter((row) => !seen.has(key(row)))], more: previous.more }
}

const chatTime = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'short', timeZone: PARIS })

function ChatPane({ id, today, person, feed, draft, setDraft, send, busy, locked, refreshing, canPage, loadOlder, openTicket }: {
  id: string; today: string; person: PersonLabel; feed?: Feed; draft: string; setDraft: (draft: string) => void;
  send: (event: FormEvent<HTMLFormElement>) => void; busy: boolean; locked: boolean; refreshing: boolean; canPage: boolean; loadOlder: () => void;
  openTicket: (day: string, proposalId: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const older = useRef<{ first: string; height: number; top: number } | undefined>(undefined)
  const rows = feed?.rows.filter((row): row is Message => 'body' in row).reverse() ?? []
  const first = rows[0]?.id
  const last = rows.at(-1)?.id
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    if (older.current && older.current.first !== first) {
      const { height, top } = older.current
      older.current = undefined
      element.scrollTop = top + element.scrollHeight - height
    } else {
      if (canPage) older.current = undefined
      if (atBottom.current) element.scrollTop = element.scrollHeight
    }
  }, [first, last, canPage])

  function showOlder() {
    const element = box.current
    if (element && first) older.current = { first, height: element.scrollHeight, top: element.scrollTop }
    loadOlder()
  }

  return <section className="chat-view" aria-labelledby="chat-heading">
    <header className="chat-group-header">
      <h2 id="chat-heading">Chat Groupe</h2>
      <ul aria-label="Participantes du groupe">
        {PEOPLE.map(({ name, color }) => <li key={name} className={`nurse-chip ${color}`}>{name}</li>)}
      </ul>
    </header>
    <div className="chat-scroll" ref={box} onScroll={({ currentTarget: e }) => { atBottom.current = e.scrollHeight - e.scrollTop - e.clientHeight < 40 }}>
      {feed?.more && <button className="load-more" disabled={!canPage} onClick={showOlder}>Messages précédents</button>}
      {!rows.length && <p className="pane-empty" role="status">{refreshing ? 'Lecture en cours…' : 'Aucun message'}</p>}
      <ol className="chat-messages">{rows.map((row, index) => {
        const date = todayInParis(new Date(row.created_at))
        const previous = rows[index - 1]
        const mine = row.member_id === id
        const name = person(row.member_id)
        const nurse = PEOPLE.find((p) => p.name === name)
        return <Fragment key={row.id}>
          {(!previous || todayInParis(new Date(previous.created_at)) !== date) && <li className="chat-day">{date === today ? 'Aujourd’hui' : dayLabel(date)}</li>}
          <li className={`msg-row${mine ? ' mine' : ''}`}>
            {!mine && <span className={`msg-avatar ${nurse?.color ?? 'unassigned'}`} aria-hidden="true">{nurse?.code ?? '–'}</span>}
            <div className="msg-bubble">
              <p className="msg-top"><strong className={mine ? 'sr-only' : undefined}>{mine ? 'Vous' : name}</strong><time dateTime={row.created_at}>{chatTime.format(new Date(row.created_at))}</time></p>
              <p className="message">{row.body.replace(/^Demande refusée · \d{2}\/\d{2}\/\d{4} \(T[12]\)(?:, \d{2}\/\d{2}\/\d{4} \(T[12]\))*(?=\nMotif : )/, (header) => header.replace(/\(T([12])\)/g, '(Tournée $1)'))}</p>
              {row.proposal_id && row.proposal_day && <button className="chat-ticket-link" onClick={() => { if (row.proposal_day && row.proposal_id) openTicket(row.proposal_day, row.proposal_id) }}>Voir la modification <span aria-hidden="true">↗</span></button>}
            </div>
          </li>
        </Fragment>
      })}</ol>
    </div>
    <form className="chat-compose" onSubmit={(event) => { if (!locked && draft.trim()) { older.current = undefined; atBottom.current = true } send(event) }}>
      <input aria-label="Message" placeholder="Écrire un message…" maxLength={2000} required value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} autoComplete="off" />
      <button className="primary icon-button" aria-label="Envoyer" disabled={locked || !draft.trim()}><Icon path="M12 20V4 M5 11l7-7 7 7" /></button>
    </form>
  </section>
}
