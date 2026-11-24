import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { timeLabel, type Client } from './data'
import { Simulation } from './simulation'

type Member = { id: string; name: string; active: boolean; must_change_password: boolean }
type Overview = { members: Member[]; history: { id: string; name: string; active: boolean; created_at: string }[] }

export function Admin({ db, token, signOut, accessLost }: { db: Client; token: string; signOut: () => void; accessLost: () => void }) {
  const [data, setData] = useState<Overview>()
  const [target, setTarget] = useState<Member>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [simulating, setSimulating] = useState(false)
  const sequence = useRef(0)

  async function refresh() {
    const request = ++sequence.current
    const result = await db.rpc('admin_overview').abortSignal(AbortSignal.timeout(10000))
    if (request !== sequence.current) return
    if (result.error) {
      setData(undefined)
      setSimulating(false)
      if ([401, 403].includes(result.status)) accessLost()
      else setNotice('Lecture indisponible. Actualisez avant toute action.')
      return
    }
    setData(result.data as Overview)
  }

  const refreshFromEffect = useEffectEvent(refresh)
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') void refreshFromEffect() }
    void refreshFromEffect()
    document.addEventListener('visibilitychange', visible)
    const timer = window.setInterval(visible, 30000)
    return () => { sequence.current++; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [db, token])

  async function apply() {
    if (!target || busy || !data) return
    setBusy(true)
    setTarget(undefined)
    const result = await db.rpc('admin_set_member_active', { p_member_id: target.id, p_active: !target.active })
      .retry(false).abortSignal(AbortSignal.timeout(10000))
    if ([401, 403].includes(result.status)) { accessLost(); return }
    setNotice(result.error ? 'Action non confirmée. Vérifiez l’état actualisé du compte.' : 'Accès mis à jour.')
    await refresh()
    setBusy(false)
  }

  if (simulating && data) return <Simulation close={() => setSimulating(false)} />

  return <main className="workspace">
    <header className="masthead">
      <div><p className="eyebrow">Planning IDEL · accès restreint</p><h1>Administration</h1><p>Gestion des accès aux comptes IDEL</p></div>
      <div className="toolbar"><button disabled={busy} onClick={() => void refresh()}>Actualiser</button><button onClick={signOut}>Déconnexion</button></div>
    </header>
    {notice && <p className="notice" role="status">{notice}</p>}
    {data && <>
      <section className="card feed" aria-labelledby="admin-simulation">
        <h2 id="admin-simulation">Simulateur de profils</h2>
        <p>Testez les parcours de Linda, Julie, Lucie et Fanny sans toucher à leurs comptes ni au planning officiel.</p>
        <button className="primary" disabled={busy || !!target} onClick={() => setSimulating(true)}>Ouvrir le simulateur</button>
      </section>
      <section className="card feed" aria-labelledby="admin-members">
        <h2 id="admin-members">Comptes IDEL</h2>
        <ul className="entries">{data.members.map((member) => <li key={member.id}>
          <p><strong>{member.name}</strong> · {member.active ? 'Accès actif' : 'Accès suspendu'}</p>
          {member.must_change_password && <p className="note">Mot de passe initial à remplacer</p>}
          <div><button disabled={busy || !!target} onClick={() => setTarget(member)}>{member.active ? 'Suspendre' : 'Réactiver'} {member.name}</button></div>
        </li>)}</ul>
        {target && <div className="notice" role="group" aria-label="Confirmation du changement">
          <p>{target.active ? `Suspendre l’accès de ${target.name} et révoquer ses sessions ?` : `Réactiver ${target.name} ? Une nouvelle connexion sera nécessaire.`}</p>
          <div className="toolbar"><button className="primary" onClick={() => void apply()}>Confirmer</button><button onClick={() => setTarget(undefined)}>Annuler</button></div>
        </div>}
      </section>
      <section className="card feed" aria-labelledby="admin-history">
        <h2 id="admin-history">Dernières actions</h2>
        {data.history.length ? <ol className="entries">{data.history.map((entry) => <li key={entry.id}>
          <p>{entry.name} · {entry.active ? 'Réactivation' : 'Suspension'} · <time dateTime={entry.created_at}>{timeLabel(entry.created_at)}</time></p>
        </li>)}</ol> : <p>Aucune action enregistrée.</p>}
      </section>
    </>}
  </main>
}
