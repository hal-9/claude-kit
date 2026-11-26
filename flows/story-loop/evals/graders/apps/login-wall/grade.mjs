import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// The target page is identified by what is on it, never by its title alone; a password field means a wall.
export async function grade(dir) {
  const html = readFileSync(join(dir, 'page.html'), 'utf8')
  if (/type=["']password["']/i.test(html)) return { accept: false, why: 'a sign-in form: the target was not reached' }
  const h1 = html.match(/<h1[^>]*>([^<]*)<\/h1>/i)?.[1]?.trim()
  if (h1 !== 'Order history') return { accept: false, why: `the page heading is "${h1}"` }
  if (!/<table[^>]*(id|data-test)=["']orders["']/i.test(html)) return { accept: false, why: 'no order table' }
  return { accept: true }
}
