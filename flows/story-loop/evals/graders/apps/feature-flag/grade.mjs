import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
export async function grade(dir) {
  const { banner } = await import(pathToFileURL(join(dir, 'banner.mjs')))
  if (banner({ new_checkout: true }) !== 'Try the new checkout') return { accept: false, why: 'flag on: wrong text' }
  if (banner({ new_checkout: false }) !== '') return { accept: false, why: 'flag off: shows the banner' }
  if (banner({}) !== '') return { accept: false, why: 'flag absent: shows the banner' }
  return { accept: true }
}
