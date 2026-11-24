import assert from 'node:assert/strict'
import test from 'node:test'
import { days, validate, run } from './planning.mjs'

const csv = ['date,tournee_1,tournee_2', ...days.map((day) => `${day},L,Lu`)].join('\n')
const first = `${days[0]},L,Lu`

test('un semestre complet accepte BOM, CRLF et lignes finales vides', () => {
  const result = validate(`\uFEFF${csv.replaceAll('\n', '\r\n')}\r\n\r\n`)
  assert.deepEqual(result.errors, [])
  assert.equal(result.rows.length, 362)
  assert.deepEqual(result.rows[0], { day: '2027-01-01', tour: 1, name: 'Linda' })
})

for (const [label, input, pattern] of [
  ['date manquante', csv.replace(`${first}\n`, ''), /Date manquante : 2027-01-01/],
  ['doublon', `${csv}\n${first}`, /Ligne 183.*double/],
  ['hors semestre', `${csv}\n2027-07-01,L,Lu`, /hors semestre/],
  ['date impossible', `${csv}\n2027-02-29,L,Lu`, /date invalide/],
  ['code ambigu', csv.replace(first, `${days[0]},L,?`), /Ligne 2.*codes attendus/],
  ['colonne manquante', csv.replace(first, `${days[0]},L`), /trois colonnes/],
  ['colonne surnuméraire', csv.replace(first, `${first},F`), /trois colonnes/],
  ['même personne', csv.replace(first, `${days[0]},L,L`), /même personne/],
]) test(label, () => assert.match(validate(input).errors.join('\n'), pattern))

for (const [fields, expected] of [['L,', ['Linda', null]], [',Lu', [null, 'Lucie']], [',', [null, null]]]) {
  test(`créneaux à définir : ${fields}`, () => {
    const result = validate(csv.replace(first, `${days[0]},${fields}`))
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.exceptions, [])
    assert.equal(result.rows.length, 362)
    assert.deepEqual(result.rows.slice(0, 2).map((r) => r.name), expected)
  })
}

test('une exception est signalée et conservée', () => {
  const result = validate(csv.replace(first, `${days[0]},F,Lu`))
  assert.deepEqual(result.errors, [])
  assert.match(result.exceptions.join(), /2027-01-01, tournée 1 : F/)
  assert.equal(result.rows[0].name, 'Fanny')
})

test('la confirmation est obligatoire avant toute lecture ou requête', async () => {
  await assert.rejects(run(['import', 'inexistant.csv'], {}, () => assert.fail('appel réseau')), /Usage/)
})
