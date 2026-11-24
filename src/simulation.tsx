import { useState } from 'react'
import { assigned, dayKey, effectiveStatus, isRefusalReason, PAGE_SIZE, PEOPLE, type Audit, type Snapshot, type Line } from './data'
import { WorkspaceView, type WorkspaceSource } from './workspace'

const today = '2026-12-31'
const stamp = '2026-12-31T10:00:00Z'
const initialId = 'demo-proposal'

const newestFirst = (a: Pick<Audit, 'created_at' | 'id'>, b: Pick<Audit, 'created_at' | 'id'>) =>
  b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)

function createScenario() {
  const snapshot: Snapshot = {
    members: PEOPLE.map(({ name }) => ({ id: name, name, active: true })),
    assignments: Array.from({ length: 181 }, (_, i) => {
      const day = dayKey(0, i + 1)
      return ([1, 2] as const).map((tour) => ({ day, tour, member_id: i === 4 ? null : (tour === 1 ? (i % 2 ? PEOPLE[1] : PEOPLE[0]) : (i % 2 ? PEOPLE[3] : PEOPLE[2])).name, version: 1 }))
    }).flat(),
    proposals: [{ id: initialId, author_id: 'Linda', status: 'pending', created_at: stamp, expires_on: '2027-01-01' }],
    lines: [{ proposal_id: initialId, day: '2027-01-01', tour: 1, before_id: 'Linda', after_id: 'Julie', before_version: 1 }],
    votes: [],
  }
  const audit: Audit[] = [{ id: 'demo-audit', kind: 'proposal', actor_id: 'Linda', proposal_id: initialId, days: ['2027-01-01'], details: { lines: snapshot.lines.slice() }, created_at: stamp }]
  let scenarioTime = Date.parse(stamp)

  function groupedHistory() {
    const proposals = new Map(snapshot.proposals.map((p) => [p.id, p]))
    const seen = new Set<string>()
    return audit.filter((entry) => entry.kind !== 'vote').sort(newestFirst).flatMap((entry) => {
      if (entry.proposal_id === null) return [entry]
      if (seen.has(entry.proposal_id)) return []
      const proposal = proposals.get(entry.proposal_id)
      if (!proposal) return []
      seen.add(proposal.id)
      return [{ ...entry, actor_id: proposal.author_id, details: {
        ...entry.details, event_actor_id: entry.actor_id, proposal_created_at: proposal.created_at,
      } }]
    })
  }

  function source(actor: string): WorkspaceSource {
    return {
      today: () => today,
      allowed: async () => PEOPLE.some((p) => p.name === actor),
      snapshot: async () => structuredClone(snapshot),
      async history(day, cursor, history = 'all') {
        const rows = groupedHistory()
          .filter((entry) => (!day || entry.days.includes(day)) && (history === 'all' || entry.kind === history))
          .filter((row) => !cursor || newestFirst(row, cursor) > 0)
        return { rows: structuredClone(rows.slice(0, PAGE_SIZE)), more: rows.length > PAGE_SIZE }
      },
      async mutate(name, args, signal) {
        signal.throwIfAborted()
        const ok = { status: 200, error: null }
        const invalid = (message: string) => ({ status: 400, error: { code: '22023', message } })
        const forbidden = (message: string) => ({ status: 403, error: { code: '42501', message } })
        if (!snapshot.members.some((member) => member.id === actor && member.active)) return forbidden('Accès réservé aux membres actifs.')
        const now = new Date(scenarioTime + 1000).toISOString()
        const log = (kind: string, id: string, lines: Line[], details: Audit['details'] = { lines }) => audit.push({
          id: crypto.randomUUID(), kind, actor_id: actor, proposal_id: id, days: [...new Set(lines.map((line) => line.day))], details, created_at: now,
        })
        if (name === 'claim_unassigned_slot') {
          const a = snapshot.assignments.find((a) => a.day === args.p_day && a.tour === args.p_tour)
          if (!a || a.member_id !== null || a.day <= today || !PEOPLE.some((m) => m.name === actor && m.tour === a.tour) ||
            snapshot.assignments.some((other) => other.day === a.day && other.member_id === actor)) return invalid('Créneau indisponible.')
          a.member_id = actor
          a.version++
          audit.push({ id: crypto.randomUUID(), kind: 'claim', actor_id: actor, proposal_id: null, days: [a.day], details: { tour: a.tour }, created_at: now })
        } else if (name === 'create_proposal') {
          const tour = args.p_tour
          const day = args.p_day
          const swap = args.p_other_day
          if ((args.p_after_id == null) === (swap == null)) return invalid('Choisissez un remplacement ou un échange.')
          const pair = PEOPLE.filter((p) => p.tour === tour).map((p) => p.name as string)
          const first = snapshot.assignments.find((a) => a.day === day && a.tour === tour)
          const second = snapshot.assignments.find((a) => a.day === swap && a.tour === tour)
          const target = second?.member_id ?? args.p_after_id
          if (!assigned(first) || first.day <= today || (swap != null && (!assigned(second) || second.day <= today || second.day === first.day || !pair.includes(first.member_id))) ||
            typeof target !== 'string' || !pair.includes(target) || first.member_id === target) return invalid('Tournée, date ou collègue incompatible.')
          const id = crypto.randomUUID()
          const line = (a: typeof first, after_id: string): Line => ({ proposal_id: id, day: a.day, tour: a.tour, before_id: a.member_id, before_version: a.version, after_id })
          const lines = [line(first, target)]
          if (assigned(second)) lines.push(line(second, first.member_id))
          lines.sort((a, b) => a.day.localeCompare(b.day) || a.tour - b.tour)
          if (lines.some((candidate) => snapshot.lines.some((l) => l.day === candidate.day && l.tour === candidate.tour &&
            snapshot.proposals.some((p) => p.id === l.proposal_id && effectiveStatus(p, today) === 'pending')))) return invalid('Une demande existe déjà pour ce créneau.')
          if (lines.some((l) => snapshot.assignments.some((a) => a.day === l.day && a.tour !== l.tour && a.member_id === l.after_id))) return invalid('Une personne ne peut pas assurer les deux tournées du jour.')
          const expires_on = second && second.day < first.day ? second.day : first.day
          snapshot.proposals.push({ id, author_id: actor, status: 'pending', created_at: now, expires_on })
          snapshot.lines.push(...lines)
          log('proposal', id, lines)
        } else if (name === 'cast_vote' || name === 'withdraw_proposal') {
          const p = snapshot.proposals.find((proposal) => proposal.id === args.p_proposal_id)
          if (!p) return invalid('Demande inconnue.')
          const lines = snapshot.lines.filter((l) => l.proposal_id === p.id)
          let refusalDetails: Audit['details'] | undefined
          if (name === 'withdraw_proposal') {
            if (p.author_id !== actor) return forbidden('Seul l’auteur peut retirer la demande.')
            if (effectiveStatus(p, today) !== 'pending') return invalid('Cette demande est fermée ou expirée.')
            p.status = 'withdrawn'
          } else {
            const approve = args.p_approve
            if (typeof approve !== 'boolean') return invalid('Vote invalide.')
            const voters = new Set(lines.flatMap((line) => [line.before_id, line.after_id]))
            if (!voters.has(actor)) return forbidden('Seules les deux personnes concernées peuvent voter.')
            if (voters.size !== 2) return invalid('La demande doit concerner exactement deux personnes.')
            if (effectiveStatus(p, today) === 'expired') return invalid('Cette demande est expirée.')
            const reasonCode = args.p_reason
            if (!approve && !isRefusalReason(reasonCode)) return invalid('Choisissez un motif de refus valide.')
            const previous = snapshot.votes.find((vote) => vote.proposal_id === p.id && vote.member_id === actor)
            if (previous) return previous.approve === approve ? ok : invalid('Un vote ne peut pas être modifié.')
            if (p.status !== 'pending') return invalid('Cette demande est déjà fermée.')
            snapshot.votes.push({ proposal_id: p.id, member_id: actor, approve, created_at: now })
            log('vote', p.id, lines, approve ? { approve } : { approve, reason_code: reasonCode })
            if (!approve) {
              p.status = 'rejected'
              refusalDetails = { lines, reason_code: reasonCode }
            } else if ([...voters].every((id) => snapshot.votes.some((v) => v.proposal_id === p.id && v.member_id === id && v.approve))) {
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
          if (p.status !== 'pending') log(p.status, p.id, lines, refusalDetails)
        } else return invalid('Action indisponible en simulation.')
        scenarioTime += 1000
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
