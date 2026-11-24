import { useState } from 'react'
import { dayKey, effectiveStatus, PAGE_SIZE, PEOPLE, type Audit, type Message, type Snapshot, type Line } from './data'
import { WorkspaceView, type Contacts, type WorkspaceSource } from './workspace'

const today = '2026-12-31'
const stamp = '2026-12-31T10:00:00Z'
const initialId = 'demo-proposal'

function createScenario() {
  const snapshot: Snapshot = {
    members: PEOPLE.map(({ name }) => ({ id: name, name, active: true })),
    assignments: Array.from({ length: 181 }, (_, i) => {
      const day = dayKey(0, i + 1)
      return ([1, 2] as const).map((tour) => ({ day, tour, member_id: (tour === 1 ? (i % 2 ? PEOPLE[1] : PEOPLE[0]) : (i % 2 ? PEOPLE[3] : PEOPLE[2])).name, version: 1 }))
    }).flat(),
    proposals: [{ id: initialId, author_id: 'Linda', status: 'pending', created_at: stamp, expires_on: '2027-01-01' }],
    lines: [{ proposal_id: initialId, day: '2027-01-01', tour: 1, before_id: 'Linda', after_id: 'Julie', before_version: 1 }],
    votes: [{ proposal_id: initialId, member_id: 'Linda', approve: true, created_at: stamp }],
  }
  const audit: Audit[] = [{ id: 'demo-audit', kind: 'proposal', actor_id: 'Linda', proposal_id: initialId, days: ['2027-01-01'], details: { lines: snapshot.lines.slice() }, created_at: stamp }]
  const messages: Message[] = [{ id: 'demo-message', member_id: 'Lucie', body: 'Bienvenue dans le planning de démonstration.', created_at: stamp }]
  let contacts: Contacts = {}

  function source(actor: string): WorkspaceSource {
    return {
      today: () => today,
      allowed: async () => PEOPLE.some((p) => p.name === actor),
      snapshot: async () => structuredClone(snapshot),
      async feed(table, day, cursor) {
        const rows = (table === 'audit' ? audit.filter((entry) => !day || entry.days.includes(day)) : messages.slice())
          .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
        const start = cursor ? rows.findIndex((row) => row.id === cursor.id) + 1 : 0
        return { rows: structuredClone(rows.slice(start, start + PAGE_SIZE)), more: rows.length > start + PAGE_SIZE }
      },
      async contacts() {
        if (actor !== 'Fanny') throw new Error('Accès réservé à Fanny.')
        return { ...contacts }
      },
      async mutate(name, args, signal) {
        signal.throwIfAborted()
        const ok = { status: 200, error: null }
        const invalid = (message: string) => ({ status: 400, error: { code: '22023', message } })
        const now = new Date().toISOString()
        const log = (kind: string, id: string, lines: Line[], details: Record<string, unknown> = { lines }) => audit.push({
          id: crypto.randomUUID(), kind, actor_id: actor, proposal_id: id, days: lines.map((line) => line.day), details, created_at: now,
        })
        if (name === 'post_message') {
          const body = String(args.p_body ?? '').trim()
          if (!body || body.length > 2000) return invalid('Le message doit contenir de 1 à 2 000 caractères.')
          messages.push({ id: crypto.randomUUID(), member_id: actor, body, created_at: now })
        } else if (name === 'save_colleague_contacts') {
          if (actor !== 'Fanny') return { status: 403, error: { code: '42501', message: 'Accès réservé à Fanny.' } }
          const next: Contacts = {}
          for (const colleague of ['Linda', 'Julie', 'Lucie'] as const) {
            const email = String(args[`p_${colleague.toLowerCase()}`] ?? '').trim()
            if (!email) continue
            if (email.length > 254 || !/^[^\s,;@]+@[^\s,;@.]+(?:\.[^\s,;@.]+)+$/.test(email)) return invalid('Vérifiez les adresses e-mail.')
            next[colleague] = email
          }
          contacts = next
        } else if (name === 'create_proposal') {
          const tour = args.p_tour
          const day = args.p_day
          const swap = args.p_other_day
          const pair = PEOPLE.filter((p) => p.tour === tour).map((p) => p.name as string)
          const first = snapshot.assignments.find((a) => a.day === day && a.tour === tour)
          const second = snapshot.assignments.find((a) => a.day === swap && a.tour === tour)
          const target = second?.member_id ?? args.p_after_id
          if (!first || first.day <= today || (swap && (!second || second.day <= today || second.day === first.day || !pair.includes(first.member_id))) ||
            typeof target !== 'string' || !pair.includes(target) || first.member_id === target) return invalid('Tournée, date ou collègue incompatible.')
          const id = crypto.randomUUID()
          const line = (a: typeof first, after_id: string): Line => ({ proposal_id: id, day: a.day, tour: a.tour, before_id: a.member_id, before_version: a.version, after_id })
          const lines = [line(first, target)]
          if (second) lines.push(line(second, first.member_id))
          if (lines.some((candidate) => snapshot.lines.some((l) => l.day === candidate.day && l.tour === candidate.tour &&
            snapshot.proposals.some((p) => p.id === l.proposal_id && effectiveStatus(p, today) === 'pending')))) return invalid('Une demande existe déjà pour ce créneau.')
          if (lines.some((l) => snapshot.assignments.some((a) => a.day === l.day && a.tour !== l.tour && a.member_id === l.after_id))) return invalid('Une personne ne peut pas assurer les deux tournées du jour.')
          snapshot.proposals.push({ id, author_id: actor, status: 'pending', created_at: now, expires_on: second && second.day < first.day ? second.day : first.day })
          snapshot.lines.push(...lines)
          snapshot.votes.push({ proposal_id: id, member_id: actor, approve: true, created_at: now })
          log('proposal', id, lines)
          log('vote', id, lines, { approve: true })
        } else if (name === 'cast_vote' || name === 'withdraw_proposal') {
          const p = snapshot.proposals.find((proposal) => proposal.id === args.p_proposal_id)
          if (!p || effectiveStatus(p, today) !== 'pending') return invalid('Cette demande est déjà fermée.')
          const lines = snapshot.lines.filter((l) => l.proposal_id === p.id)
          if (name === 'withdraw_proposal') {
            if (p.author_id !== actor) return invalid('Seul l’auteur peut retirer la demande.')
            p.status = 'withdrawn'
          } else {
            const approve = args.p_approve
            if (typeof approve !== 'boolean') return invalid('Vote invalide.')
            const previous = snapshot.votes.find((vote) => vote.proposal_id === p.id && vote.member_id === actor)
            if (previous) return previous.approve === approve ? ok : invalid('Un vote ne peut pas être modifié.')
            snapshot.votes.push({ proposal_id: p.id, member_id: actor, approve, created_at: now })
            log('vote', p.id, lines, { approve })
            if (!approve) p.status = 'rejected'
            else if (snapshot.votes.filter((v) => v.proposal_id === p.id && v.approve).length === PEOPLE.length) {
              const slots = lines.map((l) => snapshot.assignments.find((a) => a.day === l.day && a.tour === l.tour))
              if (lines.some((l, i) => slots[i]?.version !== l.before_version || slots[i]?.member_id !== l.before_id ||
                snapshot.assignments.some((a) => a.day === l.day && a.tour !== l.tour && a.member_id === l.after_id))) p.status = 'obsolete'
              else {
                for (const [index, entry] of lines.entries()) {
                  const assignment = slots[index]
                  if (assignment) { assignment.member_id = entry.after_id; assignment.version++ }
                }
                p.status = 'accepted'
              }
            }
          }
          if (p.status !== 'pending') log(p.status, p.id, lines)
        } else return invalid('Action indisponible en simulation.')
        return ok
      },
    }
  }
  return { source }
}

export function Simulation({ close }: { close: () => void }) {
  const [scenario, setScenario] = useState(createScenario)
  const [actor, setActor] = useState<string>('Linda')
  const [revision, setRevision] = useState(0)
  const [confirmReset, setConfirmReset] = useState(false)
  return <WorkspaceView key={`${actor}-${revision}`} source={scenario.source(actor)} id={actor} token="simulation" signOut={close} accessLost={close}
    controls={<aside className="simulation-controls" aria-label="Commandes de simulation">
      <p><strong>Simulation</strong> · Données fictives</p>
      <div className="toolbar">
        <label>Profil simulé<select value={actor} onChange={(event) => { setActor(event.target.value); setConfirmReset(false) }}>
          {PEOPLE.map(({ name }) => <option key={name}>{name}</option>)}
        </select></label>
        <button onClick={close}>Retour à l’administration</button>
        <button onClick={() => setConfirmReset(true)}>Réinitialiser</button>
      </div>
      {confirmReset && <div className="toolbar"><p>Effacer les actions simulées ?</p><button onClick={() => { setScenario(createScenario()); setRevision((n) => n + 1); setConfirmReset(false) }}>Confirmer</button><button onClick={() => setConfirmReset(false)}>Annuler</button></div>}
    </aside>}
  />
}
