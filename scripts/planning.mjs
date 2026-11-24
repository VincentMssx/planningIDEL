import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const people = new Map([['L', 'Linda'], ['J', 'Julie'], ['Lu', 'Lucie'], ['F', 'Fanny']])
export const days = Array.from({ length: 181 }, (_, i) => new Date(Date.UTC(2027, 0, i + 1)).toISOString().slice(0, 10))
const semester = new Set(days)

export function validate(csv) {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/)
  while (lines.length && !lines.at(-1).trim()) lines.pop()
  const errors = [], exceptions = [], rows = [], seen = new Set()
  if (lines[0] !== 'date,tournee_1,tournee_2') errors.push('Ligne 1 : en-tête attendu : date,tournee_1,tournee_2')
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(',')
    const [day, first, second] = fields
    const reasons = []
    if (fields.length !== 3) reasons.push('trois colonnes attendues')
    const parsed = new Date(`${day}T00:00:00Z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== day) reasons.push('date invalide')
    else if (!semester.has(day)) reasons.push('date hors semestre')
    else if (seen.has(day)) reasons.push('date en double')
    else seen.add(day)
    if ([first, second].some((code) => code !== '' && !people.has(code))) reasons.push('codes attendus : L, J, Lu, F ou case vide')
    else if (first && first === second) reasons.push('même personne sur les deux tournées')
    if (reasons.length) {
      errors.push(`Ligne ${i + 1} : ${reasons.join(' ; ')}`)
      continue
    }
    for (const [index, code] of [first, second].entries()) {
      const tour = index + 1
      rows.push({ day, tour, name: people.get(code) ?? null })
      if (code && (tour === 1) !== (code === 'L' || code === 'J')) exceptions.push(`Ligne ${i + 1}, ${day}, tournée ${tour} : ${code}`)
    }
  }
  for (const day of days) if (!seen.has(day)) errors.push(`Date manquante : ${day}`)
  return { errors, exceptions, rows }
}

export async function run(args, env = process.env, request = fetch, log = console) {
  const [mode, file, confirm] = args
  if (!file || !((mode === 'validate' && args.length === 2) || (mode === 'import' && args.length === 3 && confirm === '--confirm-reviewed'))) {
    throw new Error('Usage : planning validate <fichier.csv> | planning import <fichier.csv> --confirm-reviewed')
  }
  let csv
  try { csv = await readFile(file, 'utf8') } catch { throw new Error('Lecture du CSV impossible.') }
  const { errors, exceptions, rows } = validate(csv)
  if (exceptions.length) log.info(`Exceptions de binôme :\n${exceptions.join('\n')}`)
  if (errors.length) throw new Error(errors.join('\n'))
  log.info(`${days.length} jours, ${rows.length} créneaux valides, dont ${rows.filter((row) => row.name === null).length} à définir.`)
  if (mode === 'validate') return
  const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = env
  if (!url || !key) throw new Error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis.')
  let endpoint
  try { endpoint = new URL('/rest/v1/rpc/import_schedule', url) } catch { throw new Error('URL Supabase invalide.') }
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new Error('HTTPS requis hors recette locale.')
  let response
  try {
    response = await request(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ p_rows: rows }),
    })
  } catch { throw new Error('Import non confirmé : vérifier la base avant toute nouvelle tentative.') }
  if (!response.ok) throw new Error(`Import non confirmé (HTTP ${response.status}) : vérifier la base avant toute nouvelle tentative.`)
  if (await response.json().catch(() => null) !== rows.length) throw new Error('Nombre importé non confirmé : vérifier la base avant toute nouvelle tentative.')
  log.info(`${rows.length} créneaux importés.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1 })
}
