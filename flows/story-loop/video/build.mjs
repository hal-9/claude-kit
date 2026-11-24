#!/usr/bin/env node
// Builds the story-loop explainer video with what a Mac already has:
// `say` for the voice, the board's own demo for footage, Playwright to render
// explainer.html frame by frame, ffmpeg to encode.
//   node build.mjs [voice] [shots] [render] [mix]   (no argument: all of them)
//   Background music: put a track at video/music.mp3 (git-ignored), or MUSIC=<file>.
//   MUSIC_DB=-24 node build.mjs mix                  (quieter music, no re-render)
//   MUSIC_START=22 starts the track 22 seconds in (both can live in video/.env).
//   VOICE="Ava (Premium)" node build.mjs voice    (any voice from: say -v '?')
// Playwright is taken from the directory you run this in (a repo that has it
// in node_modules), or from PLAYWRIGHT_FROM.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const SHOTS = join(HERE, 'shots')
const VOICE = process.env.VOICE || 'Samantha'
const RATE = process.env.RATE || '172'
const FPS = 30
const SIZE = { width: 1280, height: 720 }
const PAUSE = 0.55 // silence after each scene

const steps = process.argv.slice(2)
const wants = step => !steps.length || steps.includes(step)
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const sleep = ms => new Promise(done => setTimeout(done, ms))
const playwright = () => createRequire(join(process.env.PLAYWRIGHT_FROM || process.cwd(), 'x.js'))('playwright')
// Use the newest headless Chromium Playwright has already downloaded, so a
// version mismatch with this repo's Playwright does not mean another download.
function launch() {
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  const shells = existsSync(cache) ? readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort() : []
  const found = shells.map(d => join(cache, d, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')).filter(existsSync).at(-1)
  const executablePath = process.env.CHROME_PATH || found
  return playwright().chromium.launch(executablePath ? { executablePath } : {})
}

mkdirSync(OUT, { recursive: true })
mkdirSync(SHOTS, { recursive: true })

// ---- voice: one clip per scene, then scenes.js with the timings the page animates to

// With ELEVENLABS_API_KEY in video/.env (git-ignored) the narration comes from
// ElevenLabs; without it, from the Mac's own `say`. The key is only ever sent
// to api.elevenlabs.io and is never printed.
try { process.loadEnvFile(join(HERE, '.env')) } catch { /* no .env: local voice */ }
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb' // "George", a default voice
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2'

async function speak(text, base) {
  if (!ELEVEN_KEY) {
    sh('say', ['-v', VOICE, '-r', RATE, '-o', `${base}.aiff`, text])
    return `${base}.aiff`
  }
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVEN_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: ELEVEN_MODEL }),
  })
  if (!response.ok) throw new Error(`ElevenLabs answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
  writeFileSync(`${base}.mp3`, Buffer.from(await response.arrayBuffer()))
  return `${base}.mp3`
}

async function voice() {
  const script = JSON.parse(readFileSync(join(HERE, 'script.json'), 'utf8'))
  let start = 0
  const list = []
  const scenes = []
  for (const scene of script) {
    const wav = join(OUT, `${scene.id}.wav`)
    const raw = await speak(scene.text, join(OUT, scene.id))
    const spoken = Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', raw]))
    const duration = Math.round((spoken + PAUSE) * 100) / 100
    sh('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-af', 'apad', '-t', String(duration), '-ar', '44100', '-ac', '2', wav])
    list.push(`file '${wav}'`)
    // Captions: one per sentence, timed by its share of the scene's characters.
    const sentences = scene.text.match(/[^.?!:]+[.?!:]+/g).map(s => s.trim())
    const total = sentences.reduce((n, s) => n + s.length, 0)
    let at = start
    const captions = sentences.map(text => {
      const end = at + spoken * (text.length / total)
      const caption = { text, start: Math.round(at * 100) / 100, end: Math.round(end * 100) / 100 }
      at = end
      return caption
    })
    scenes.push({ id: scene.id, start: Math.round(start * 100) / 100, duration, captions })
    start += duration
  }
  writeFileSync(join(OUT, 'audio.txt'), list.join('\n') + '\n')
  sh('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(OUT, 'audio.txt'), '-c', 'copy', join(OUT, 'voice.wav')])
  writeFileSync(join(HERE, 'scenes.js'), `window.SCENES = ${JSON.stringify(scenes, null, 2)}\n`)
  console.log(`voice: ${scenes.length} scenes, ${start.toFixed(1)}s, ${ELEVEN_KEY ? `ElevenLabs voice ${ELEVEN_VOICE}` : `local voice "${VOICE}"`}`)
}

// ---- shots: real screenshots of the board, taken from its demo replay. Where
// the page should look in each one is measured from the board's own elements
// and written to regions.js, so a board redesign needs no hand-measured pixels.

async function shots() {
  const port = 4391
  const VIEW = { width: 1440, height: 900 }
  const server = spawn('node', [join(HERE, '../skills/story-loop/board/server.mjs'), '--demo', '--port', String(port)], { stdio: 'ignore' })
  let browser
  // Everything after the spawn sits inside try: a failed launch must not leave the server running.
  try {
    browser = await launch()
    const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 2, colorScheme: 'dark' })
    await sleep(800)
    await page.goto(`http://127.0.0.1:${port}`)
    if (!(await page.getByText('Second review').count())) throw new Error(`port ${port} is serving another board; stop whatever listens there`)
    const shot = name => page.screenshot({ path: join(SHOTS, `${name}.png`) })
    // A box in viewport fractions [x0, y0, x1, y1], padded by `pad` pixels.
    const frac = ({ x, y, width, height }, pad = 0) =>
      [(x - pad) / VIEW.width, (y - pad) / VIEW.height, (x + width + pad) / VIEW.width, (y + height + pad) / VIEW.height].map(v => Math.round(v * 1000) / 1000)
    const union = boxes => {
      const x0 = Math.min(...boxes.map(b => b.x)), y0 = Math.min(...boxes.map(b => b.y))
      return { x: x0, y: y0, width: Math.max(...boxes.map(b => b.x + b.width)) - x0, height: Math.max(...boxes.map(b => b.y + b.height)) - y0 }
    }
    const boxOf = locator => locator.boundingBox().then(b => { if (!b) throw new Error(`not on the board: ${locator}`); return b })
    // The board's header is sticky: 110px keeps a heading clear of it.
    const atTop = async (locator, offset = 110) => { await locator.evaluate((el, o) => scrollTo(0, el.getBoundingClientRect().top + scrollY - o), offset); await sleep(700) }
    const regions = {}

    await sleep(9_000); await shot('board-build')           // workers building
    regions.stages = frac(union(await Promise.all((await page.getByRole('button', { name: /show what this stage ended with/ }).all()).map(boxOf))), 36)
    await sleep(25_000); await shot('board-back')           // the second review sent work back
    await sleep(24_000); await shot('board-waiting')        // waiting on Copilot, needs you

    const working = page.getByRole('heading', { name: /^Working now/ })
    await atTop(working); await shot('board-columns')
    const evidence = await boxOf(page.getByRole('heading', { name: /^Evidence/ }))
    const w = await boxOf(working)
    // The left column runs from its heading to just before "Understand this change".
    const column = (await boxOf(page.getByRole('heading', { name: /^Understand this change/ }))).x - 40 - w.x
    regions.columns = frac({ x: w.x, y: w.y, width: column, height: Math.min(evidence.y, VIEW.height) - w.y - 16 }, 20)

    const tested = page.getByRole('heading', { name: /^Tested in the browser/ })
    await atTop(tested); await shot('board-tested')
    const t = await boxOf(tested)
    regions.tested = frac({ x: t.x, y: t.y, width: column, height: 540 }, 20)

    await page.getByRole('button', { name: 'Explain this: sidebar_helper.rb' }).evaluate(b => b.click())
    await sleep(1500)
    await atTop(page.getByRole('button', { name: /All files/ }))
    await shot('board-explain')
    const detail = await page.evaluate(() => {
      const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
      const visible = el => el.getBoundingClientRect().height > 0
      const button = text => box([...document.querySelectorAll('button')].find(b => visible(b) && b.textContent.trim() === text))
      const para = lead => box([...document.querySelectorAll('strong, b')].find(s => visible(s) && s.textContent.trim() === lead).parentElement)
      return { buttons: ['Explain this', 'Why here?', 'How it connects'].map(button), paras: ['What it does.', 'Why here.', 'How it connects.'].map(para) }
    })
    regions.buttons = detail.buttons.map(b => frac(b, 0))
    regions.paras = detail.paras.map(b => frac(b, 6))
    regions.explain = frac(union([...detail.buttons, ...detail.paras]), 24)
    writeFileSync(join(HERE, 'regions.js'), `window.REGIONS = ${JSON.stringify(regions, null, 2)}\n`)
    console.log(`shots: 6 screenshots in ${SHOTS}, regions in regions.js`)
  } finally {
    await browser?.close()
    server.kill()
  }
}

// ---- render: explainer.html is a pure function of time (window.seek), so every
// frame is a screenshot at an exact timestamp; no screen recording, no dropped frames.

async function render() {
  const browser = await launch()
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1.5 })
  await page.goto(pathToFileURL(join(HERE, 'explainer.html')).href)
  await page.evaluate(() => document.fonts.ready)
  const total = await page.evaluate(() => window.TOTAL)
  const frames = Math.ceil(total * FPS)
  const silent = join(OUT, 'silent.mp4')
  const ffmpeg = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '21', '-preset', 'slow', '-vf', 'scale=1920:1080:flags=lanczos', silent], { stdio: ['pipe', 'inherit', 'inherit'] })
  for (let i = 0; i < frames; i++) {
    await page.evaluate(t => window.seek(t), i / FPS)
    const frame = await page.screenshot({ type: 'jpeg', quality: 93 })
    if (!ffmpeg.stdin.write(frame)) await new Promise(done => ffmpeg.stdin.once('drain', done))
    if (i % 300 === 0) console.log(`render: ${Math.round((i / frames) * 100)}%`)
  }
  ffmpeg.stdin.end()
  await new Promise((done, fail) => ffmpeg.on('close', code => code ? fail(new Error(`ffmpeg exited ${code}`)) : done()))
  await browser.close()
  console.log(`render: ${frames} frames (${total.toFixed(1)}s)`)
}

// ---- mix: picture + voice, plus video/music.mp3 quietly underneath when it exists.
// Separate from render, so the sound can be redone without redrawing a frame.

function mix() {
  const silent = join(OUT, 'silent.mp4')
  const final = join(OUT, 'story-loop.mp4')
  const music = process.env.MUSIC || join(HERE, 'music.mp3')
  const length = Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', silent]))
  const encode = ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-t', String(length), '-movflags', '+faststart', final]
  if (!existsSync(music)) {
    sh('ffmpeg', ['-y', '-v', 'error', '-i', silent, '-i', join(OUT, 'voice.wav'), '-map', '0:v', '-map', '1:a', ...encode])
    return console.log(`mix: ${final}, voice only`)
  }
  // The music loops if it is shorter than the film, sits well under the voice,
  // dips further while someone speaks, and fades in and out.
  const level = process.env.MUSIC_DB || '-21'
  const graph = [
    `[2:a]aloop=loop=-1:size=2e9,atrim=0:${length},volume=${level}dB,afade=t=in:d=2,afade=t=out:st=${(length - 3).toFixed(2)}:d=3[bed]`,
    `[1:a]apad,atrim=0:${length},asplit[voice][key]`,
    `[bed][key]sidechaincompress=threshold=0.03:ratio=4:attack=40:release=600[ducked]`,
    `[voice][ducked]amix=inputs=2:normalize=0[a]`,
  ].join(';')
  sh('ffmpeg', ['-y', '-v', 'error', '-i', silent, '-i', join(OUT, 'voice.wav'), '-ss', process.env.MUSIC_START || '0', '-i', music, '-filter_complex', graph, '-map', '0:v', '-map', '[a]', ...encode])
  console.log(`mix: ${final}, voice over music at ${level} dB`)
}

if (wants('voice')) await voice()
if (wants('shots')) await shots()
if (wants('render')) await render()
if (wants('mix') || wants('render')) mix()
