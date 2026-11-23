import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react'
import {
  canReadPlanning, readAccount, readFeed, readSnapshot, todayInParis, defaultMonth, dayKey,
  dayLabel, shortDayLabel, timeLabel, effectiveStatus, slot, MONTHS, PEOPLE, STATUS,
  type Audit, type Client, type Snapshot, type Tour,
} from './data'

type Props = { db: Client; id: string; token: string; signOut: () => void; accessLost: () => void }
type Feed = Awaited<ReturnType<typeof readFeed>>
type FeedTable = 'audit' | 'messages'
type View = 'calendar' | FeedTable
const weekday = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim']
const auditTitles: Record<string, string> = { import: 'Import du planning officiel', proposal: 'Nouvelle demande', vote: 'Vote', withdrawn: 'Retrait', accepted: 'Accord appliqué', rejected: 'Refus', obsolete: 'Demande devenue obsolète' }

export function Workspace({ db, id, token, signOut, accessLost }: Props) {
  const [today, setToday] = useState(todayInParis)
  const [month, setMonth] = useState(() => defaultMonth(today))
  const [day, setDay] = useState<string | null>(null)
  const [view, setView] = useState<View>('calendar')
  const [filter, setFilter] = useState('')
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

  async function refresh() {
    const request = ++serial.current
    setRefreshing(true)
    setPaging(false)
    setToday(todayInParis())
    try {
      const account = await readAccount(db)
      if (request !== serial.current) return
      if (!account.active || account.must_change_password || !await canReadPlanning(db, id)) {
        if (request === serial.current) accessLost()
        return
      }
      if (request !== serial.current) return
      const [planning, audit, messages] = await Promise.all([
        readSnapshot(db, day),
        view === 'audit' ? readFeed(db, 'audit', filter) : undefined,
        view === 'messages' ? readFeed(db, 'messages', '') : undefined,
      ])
      if (request !== serial.current) return
      // RLS can silently return empty rows if authorization changed during the reads.
      if (!planning.members.some((m) => m.id === id && m.active)) { accessLost(); return }
      setSnapshot(planning)
      setFeeds((old) => ({ filter, audit: audit ?? (old.filter === filter ? old.audit : undefined), messages: messages ?? old.messages }))
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
  useEffect(() => { void refreshFromEffect() }, [db, token, day, view, filter])
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

  async function mutate(name: string, args: Record<string, unknown>, onConfirmed?: () => void) {
    if (sending.current || refreshing || stale || unconfirmed) return
    sending.current = true
    setBusy(true)
    setNotice('')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15_000)
    try {
      const { error, status } = await db.rpc(name, args).retry(false).abortSignal(controller.signal)
      if (error) {
        if (status === 0 || status === 408 || status >= 500) throw error
        setNotice(status === 400 && error.code === '22023' ? error.message : 'Action refusée par le serveur.')
      } else {
        onConfirmed?.()
        setNotice('Action enregistrée.')
      }
    } catch {
      setUnconfirmed(true)
      setNotice('Action non confirmée. Vérifiez le planning ou le fil actualisé avant toute nouvelle tentative.')
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
      const next = await readFeed(db, table, filter, feed.rows.at(-1))
      if (request !== serial.current) return
      setFeeds((old) => ({ ...old, [table]: { ...next, rows: [...feed.rows, ...next.rows] } }))
    } catch {
      if (request === serial.current) { setNotice('Impossible de lire la page suivante.'); await refresh() }
    } finally { if (request === serial.current) setPaging(false) }
  }

  const person = (member: string | null) => snapshot?.members.find((m) => m.id === member)?.name ?? (member ? 'Membre' : 'Import')
  const bySlot = new Map(snapshot?.assignments.map((a) => [slot(a.day, a.tour), a]))
  const open = new Set(snapshot?.proposals.filter((p) => effectiveStatus(p, today) === 'pending').map((p) => p.id))
  const openSlots = new Set(snapshot?.lines.filter((l) => open.has(l.proposal_id)).map((l) => slot(l.day, l.tour)))
  const markedDays = new Set(snapshot?.lines.filter((l) => open.has(l.proposal_id)).map((l) => l.day))
  const dayProposals = snapshot?.proposals.filter((p) => snapshot.lines.some((l) => l.day === day && l.proposal_id === p.id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)) ?? []
  const locked = busy || refreshing || stale || unconfirmed
  const monthDays = new Date(Date.UTC(2027, month + 1, 0)).getUTCDate()
  const offset = (new Date(Date.UTC(2027, month, 1)).getUTCDay() + 6) % 7
  const feed = view === 'calendar' || (view === 'audit' && feeds.filter !== filter) ? undefined : feeds[view]

  function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const body = draft.trim()
    if (body) void mutate('post_message', { p_body: body }, () => setDraft(''))
  }

  return <main className="workspace">
    <header className="masthead">
      <div><p className="eyebrow">Cabinet IDEL / semestre 01</p><h1>Le planning des tournées</h1><p>Janvier à juin 2027</p></div>
      <div className="toolbar"><span>{person(id)}</span><button onClick={signOut}>Déconnexion</button></div>
    </header>
    <div className="navline">
      <nav aria-label="Espace de travail">
        <button aria-current={view === 'calendar' ? 'page' : undefined} disabled={busy} onClick={() => setView('calendar')}>Planning</button>
        <button aria-current={view === 'audit' ? 'page' : undefined} disabled={busy} onClick={() => { setFilter(''); setView('audit') }}>Historique</button>
        <button aria-current={view === 'messages' ? 'page' : undefined} disabled={busy} onClick={() => setView('messages')}>Chat</button>
      </nav>
      <button disabled={busy || refreshing} onClick={() => void refresh()}>Actualiser</button>
    </div>
    {stale && <p className="notice" role="alert">{snapshot ? 'Données non actualisées : dernière lecture disponible.' : 'Lecture indisponible.'} Vérifiez la connexion, puis actualisez.</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {!snapshot && !stale && <p role="status">Lecture de l’espace privé…</p>}
    {snapshot && view === 'calendar' && <div className="calendar-layout">
      <section className="card" aria-labelledby="month-heading">
        <div className="month-head">
          <button aria-label="Mois précédent" disabled={month === 0 || busy} onClick={() => { setMonth(month - 1); setDay(null) }}>‹</button>
          <h2 id="month-heading">{MONTHS[month]} <span>2027</span></h2>
          <button aria-label="Mois suivant" disabled={month === 5 || busy} onClick={() => { setMonth(month + 1); setDay(null) }}>›</button>
        </div>
        {!snapshot.assignments.length && <p className="notice">Aucun planning officiel n’a été importé.</p>}
        <div className="weekdays" aria-hidden="true">{weekday.map((label) => <span key={label}>{label}</span>)}</div>
        <div className="calendar">
          {Array.from({ length: offset }, (_, i) => <span key={`gap-${i}`} />)}
          {Array.from({ length: monthDays }, (_, i) => {
            const date = dayKey(month, i + 1)
            const marked = markedDays.has(date)
            const codes = ([1, 2] as const).map((tour) => {
              const a = bySlot.get(slot(date, tour))
              return a && PEOPLE.find((p) => p.name === person(a.member_id))
            })
            return <button key={date} className={`day${marked ? ' marked' : ''}`} aria-pressed={day === date} aria-current={today === date ? 'date' : undefined}
              aria-label={`${dayLabel(date)}, tournée 1 : ${codes[0]?.name ?? 'non attribuée'}, tournée 2 : ${codes[1]?.name ?? 'non attribuée'}${marked ? ', demande ouverte' : ''}`}
              disabled={busy} onClick={() => setDay(date)}>
              <span className="day-number">{i + 1}{marked && <span className="diamond" aria-hidden="true" />}</span>
              {codes.map((p, index) => <span key={index} className={`code ${p?.color ?? 'unassigned'}`} aria-hidden="true">{p?.code ?? '–'}</span>)}
            </button>
          })}
        </div>
        <p className="note">1re ligne : tournée 1 · 2e ligne : tournée 2. Le losange signale une demande ouverte.</p>
        <ul className="legend">{PEOPLE.map((p) => <li key={p.code}><span className={`code ${p.color}`}>{p.code}</span> {p.name}</li>)}</ul>
      </section>
      <section className="card detail" aria-labelledby="day-heading">
        <p className="eyebrow">Détail du jour</p>
        <h2 id="day-heading">{day ? dayLabel(day) : 'Choisir une date'}</h2>
        {day ? <>
          <h3>Affectations officielles</h3>
          <ol className="assignments">{([1, 2] as const).map((tour) => {
            const a = bySlot.get(slot(day, tour))
            return <li key={tour}><span>Tournée {tour}</span><strong>{a ? person(a.member_id) : 'Non attribuée'}</strong></li>
          })}</ol>
          <button disabled={busy} onClick={() => { setFilter(day); setView('audit') }}>Historique de ce jour</button>
          <h3>Demandes</h3>
          {!dayProposals.length && <p>{refreshing ? 'Vérification en cours…' : 'Aucune demande pour cette date.'}</p>}
          {dayProposals.map((p) => {
            const status = effectiveStatus(p, today)
            const votes = snapshot.votes.filter((v) => v.proposal_id === p.id)
            const myVote = votes.find((v) => v.member_id === id)
            return <article className="proposal" key={p.id}>
              <p><strong>{STATUS[status]}</strong> · {votes.filter((v) => v.approve).length} / 4 accords</p>
              <p className="note">Proposée par {person(p.author_id)} · {timeLabel(p.created_at)}</p>
              <ul>{snapshot.lines.filter((l) => l.proposal_id === p.id).map((l) => <li key={slot(l.day, l.tour)}>{shortDayLabel(l.day)}, tournée {l.tour} : {person(l.before_id)} → {person(l.after_id)}</li>)}</ul>
              <ul className="votes">{snapshot.members.map((m) => {
                const vote = votes.find((v) => v.member_id === m.id)
                return <li key={m.id}>{m.name} : {vote ? (vote.approve ? 'oui' : 'non') : 'sans vote'}</li>
              })}</ul>
              {status === 'pending' && <div className="toolbar">
                {!myVote && <><button className="primary" disabled={locked} onClick={() => void mutate('cast_vote', { p_proposal_id: p.id, p_approve: true })}>Approuver</button><button disabled={locked} onClick={() => void mutate('cast_vote', { p_proposal_id: p.id, p_approve: false })}>Refuser</button></>}
                {p.author_id === id && <button disabled={locked} onClick={() => void mutate('withdraw_proposal', { p_proposal_id: p.id })}>Retirer</button>}
              </div>}
            </article>
          })}
          {day > today && bySlot.has(slot(day, 1)) && <ProposalForm key={day} {...{ day, today, snapshot, bySlot, openSlots, locked, mutate }} />}
          {day <= today && <p className="note">Seules les dates futures peuvent être modifiées.</p>}
        </> : <p>Sélectionnez un jour pour voir les affectations, les demandes et les votes.</p>}
      </section>
    </div>}
    {snapshot && view !== 'calendar' && <section className="card feed">
      <h2>{view === 'audit' ? 'Historique des décisions' : 'Chat du groupe'}</h2>
      {view === 'audit' ? <>
        <label>Filtrer par jour<input type="date" min="2027-01-01" max="2027-06-30" value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
        {filter && <button onClick={() => setFilter('')}>Toutes les dates</button>}
      </> : <form onSubmit={send}>
        <p id="no-patient" className="notice">Aucune donnée patient. Envoyez uniquement des messages liés à l’organisation des tournées.</p>
        <label>Message<textarea rows={3} maxLength={2000} required value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} aria-describedby="no-patient" /></label>
        <button className="primary" disabled={locked || !draft.trim()}>Envoyer</button>
      </form>}
      {!feed?.rows.length && <p>{refreshing ? 'Lecture en cours…' : 'Aucun élément à afficher.'}</p>}
      <ol className="entries">{feed?.rows.map((row) => 'body' in row
        ? <li key={row.id}><p><strong>{person(row.member_id)}</strong> · <time dateTime={row.created_at}>{timeLabel(row.created_at)}</time></p><p className="message">{row.body}</p></li>
        : <AuditEntry key={row.id} row={row} person={person} />)}</ol>
      {feed?.more && <button disabled={paging || refreshing || stale} onClick={() => void more(view, feed)}>Afficher les éléments précédents</button>}
    </section>}
  </main>
}

function ProposalForm({ day, today, snapshot, bySlot, openSlots, locked, mutate }: {
  day: string; today: string; snapshot: Snapshot; bySlot: Map<string, Snapshot['assignments'][number]>; openSlots: Set<string>; locked: boolean;
  mutate: (name: string, args: Record<string, unknown>) => Promise<void>;
}) {
  const [tour, setTour] = useState<Tour>(1)
  const [exchange, setExchange] = useState(false)
  const [choice, setChoice] = useState('')
  const current = bySlot.get(slot(day, tour))?.member_id
  const opposite = tour === 1 ? 2 : 1
  const pair = snapshot.members.filter((m) => PEOPLE.some((p) => p.name === m.name && p.tour === tour))
  const replacements = pair.filter((m) => m.id !== current && m.id !== bySlot.get(slot(day, opposite))?.member_id)
  const dates = pair.some((m) => m.id === current) ? snapshot.assignments.filter((a) =>
    a.tour === tour && a.day !== day && a.day > today && a.member_id !== current && pair.some((m) => m.id === a.member_id)
    && !openSlots.has(slot(a.day, tour)) && bySlot.get(slot(a.day, opposite))?.member_id !== current && bySlot.get(slot(day, opposite))?.member_id !== a.member_id) : []
  const options = exchange ? dates.map((a) => ({ value: a.day, label: shortDayLabel(a.day) })) : replacements.map((m) => ({ value: m.id, label: m.name }))
  const blocked = openSlots.has(slot(day, tour))
  const selected = options.some((o) => o.value === choice) ? choice : ''
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!selected || blocked || locked) return
    void mutate('create_proposal', { p_day: day, p_tour: tour, ...(exchange ? { p_other_day: selected } : { p_after_id: selected }) })
  }
  return <form className="proposal-form" onSubmit={submit}>
    <h3>Nouvelle demande</h3>
    <p className="note">Proposer compte comme votre premier oui. L’officiel ne change qu’après quatre accords.</p>
    <label>Tournée<select value={tour} onChange={(e) => { setTour(e.target.value === '2' ? 2 : 1); setChoice('') }}><option value={1}>Tournée 1</option><option value={2}>Tournée 2</option></select></label>
    <label>Type<select value={exchange ? 'exchange' : 'replace'} onChange={(e) => { setExchange(e.target.value === 'exchange'); setChoice('') }}><option value="replace">Réaffectation</option><option value="exchange">Échange de dates</option></select></label>
    <label>{exchange ? 'Autre date' : 'Nouvelle personne'}<select required value={selected} onChange={(e) => setChoice(e.target.value)} disabled={blocked || !options.length}><option value="">Choisir…</option>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
    {blocked ? <p>Une demande est déjà ouverte pour ce créneau.</p> : !options.length && <p>Aucune option compatible.</p>}
    <button className="primary" disabled={locked || blocked || !selected}>Proposer</button>
  </form>
}

function AuditEntry({ row, person }: { row: Audit; person: (id: string | null) => string }) {
  const lines = Array.isArray(row.details.lines) ? row.details.lines as Snapshot['lines'] : []
  return <li>
    <p><strong>{auditTitles[row.kind] ?? row.kind}</strong> · {person(row.actor_id)} · <time dateTime={row.created_at}>{timeLabel(row.created_at)}</time></p>
    {row.kind === 'import' ? <p>{String(row.details.slot_count)} créneaux</p> : <p>{row.days.map(shortDayLabel).join(', ')}{row.kind === 'vote' && (row.details.approve ? ' · Oui' : ' · Non')}</p>}
    {lines.length > 0 && <ul>{lines.map((l) => <li key={slot(l.day, l.tour)}>{shortDayLabel(l.day)}, tournée {l.tour} : {person(l.before_id)} → {person(l.after_id)}</li>)}</ul>}
  </li>
}
