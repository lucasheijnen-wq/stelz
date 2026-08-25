// No invisible characters in the source tree.
//
// WHY THIS TEST EXISTS. Twice in one afternoon an invisible character reached a
// source file. Once a zero-width joiner in a comment, in the file whose job is
// stripping zero-width joiners, which is merely funny. Once a literal NUL as
// the separator in `[...].join()`, which is not: a NUL makes grep treat the
// whole file as binary and go quiet, so searching Home.tsx for `refreshData`
// printed nothing while the identifier sat on ten lines of it. A search that
// returns no matches looks exactly like a search that found none.
//
// Neither was caught in review, because being unreviewable is what an invisible
// character IS. Neither broke anything either: TypeScript, Vite and ESLint were
// all perfectly happy. The only thing that catches this class of mistake is
// something that reads the bytes, so that is what this does.
//
// ALLOWED: tab, newline, carriage return. Everything else below U+0020, plus
// DEL, the zero-width family and NBSP, is a mistake — a paste out of a browser,
// a helpful editor, or a tool emitting a control character where a space was
// meant. When one is genuinely wanted in a string it goes in as an escape, and
// an escape is six visible characters that this test never sees.
//
// DELIBERATELY NO ESCAPES AND NO REGEX LITERALS BELOW. Both would mean typing
// the characters, or something that looks like them, into this file — and
// getting that wrong is the exact failure being guarded against. Code points
// are numbers, and a number is legible.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// fileURLToPath, not .pathname: this repository lives under "Stelz tool", and
// a URL's pathname keeps the space percent-encoded, so readdir was handed a
// directory that does not exist.
const ROOT = fileURLToPath(new URL('..', import.meta.url))

const TAB = 9
const NEWLINE = 10
const CARRIAGE_RETURN = 13
const SPACE = 32
const DEL = 127

/** Named, so a failure says what was found rather than only that something was. */
const FORBIDDEN: [number, string][] = [
  [0x0000, 'NUL — hierdoor ziet grep het bestand als binair en zwijgt het'],
  [0x200B, 'zero-width space'],
  [0x200C, 'zero-width non-joiner'],
  [0x200D, 'zero-width joiner'],
  [0xFEFF, 'byte-order mark'],
  [0x00A0, 'no-break space — ziet eruit als een spatie, is het niet'],
  [0x2028, 'line separator'],
  [0x2029, 'paragraph separator'],
]

/** Index of the first control character, or -1. */
export function firstControl(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === TAB || c === NEWLINE || c === CARRIAGE_RETURN) continue
    if (c < SPACE || c === DEL) return i
  }
  return -1
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(full)
  }
  return out
}

const at = (text: string, index: number) => text.slice(0, index).split('\n').length
const name = (code: number) => 'U+' + code.toString(16).toUpperCase().padStart(4, '0')

describe('broncode bevat geen onzichtbare tekens', () => {
  const files = sources(ROOT)

  it('vindt bestanden om te controleren', () => {
    // Zonder deze regel levert een kapot pad een groene test op, en dat is de
    // enige uitkomst die erger is dan een rode.
    expect(files.length).toBeGreaterThan(40)
  })

  it('bevat geen enkel onzichtbaar teken', () => {
    const found: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const [code, why] of FORBIDDEN) {
        const i = text.indexOf(String.fromCharCode(code))
        if (i === -1) continue
        found.push(`${file.slice(ROOT.length)}:${at(text, i)} — ${name(code)} ${why}`)
      }
    }
    expect(found).toEqual([])
  })

  it('bevat geen stuurtekens buiten tab, newline en carriage return', () => {
    const found: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const i = firstControl(text)
      if (i === -1) continue
      found.push(`${file.slice(ROOT.length)}:${at(text, i)} — ${name(text.charCodeAt(i))}`)
    }
    expect(found).toEqual([])
  })

  it('betrapt een stuurteken als er een is', () => {
    // De scan moet zelf kunnen falen. Zonder dit zou een scan die niets meer
    // onderzoekt — verkeerd pad, verkeerde extensie — voor altijd groen staan.
    expect(firstControl('gewone tekst\n\tmet tab')).toBe(-1)
    expect(firstControl('nul' + String.fromCharCode(0) + 'byte')).toBe(3)
    expect(firstControl('del' + String.fromCharCode(DEL))).toBe(3)
  })
})
