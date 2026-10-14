import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright'

const origin = 'http://127.0.0.1:5183'
const artifacts = 'artifacts/browser'
await mkdir(artifacts, { recursive: true })
const server = spawn(
  'bun',
  ['run', 'dev', '--host', '127.0.0.1', '--port', '5183', '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)
const logs = []
server.stdout.on('data', data => logs.push(String(data)))
server.stderr.on('data', data => logs.push(String(data)))
const state = { browser: undefined, page: undefined }
try {
  const readiness = { ready: false, attempts: 300 }
  while (!readiness.ready && readiness.attempts-- > 0) {
    try {
      readiness.ready = (await fetch(`${origin}/lab.html`)).ok
    } catch {
      await sleep(100)
    }
  }
  assert(readiness.ready, `Vite did not start: ${logs.join('')}`)
  state.browser = await chromium.launch()
  state.page = await state.browser.newPage({
    viewport: { width: 1280, height: 900 },
  })
  const page = state.page
  page.setDefaultTimeout(20_000)
  const exceptions = []
  page.on('pageerror', error => exceptions.push(error.message))
  await page.goto(`${origin}/tests/browser/analysis.html`)
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor()
  await page.waitForFunction(() => document.body.innerText.includes('chunks'))
  await page.evaluate(() => {
    window.browserSmokeFrames = 0
    const count = () => {
      window.browserSmokeFrames += 1
      requestAnimationFrame(count)
    }
    requestAnimationFrame(count)
  })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.waitForFunction(
    () =>
      document.body.innerText.includes('Cancelled') &&
      !document.body.innerText.includes('Running'),
  )
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Fewer steps', exact: true }).click()
  await page.getByRole('button', { name: 'Compare', exact: true }).click()
  await page.getByLabel('Comparison', { exact: true }).waitFor()
  await page
    .getByRole('button', { name: 'More comparison steps', exact: true })
    .click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.waitForFunction(
    () =>
      document.body.innerText.includes('Cancelled') &&
      !document.body.innerText.includes('Running'),
  )
  const frames = await page.evaluate(() => window.browserSmokeFrames)
  assert(
    frames > 0,
    'No browser animation frames while analysis and controls ran',
  )
  await page
    .getByLabel('Comparison', { exact: true })
    .selectOption({ label: 'Browser changed heading' })
  await page.waitForFunction(
    () =>
      document.body.innerText.includes('Content changed') &&
      !document.body.innerText.includes('Running'),
  )
  await page.getByRole('button', { name: 'Replay fresh', exact: true }).click()
  await page.waitForFunction(() =>
    document.body.innerText.includes(
      'Replayed both versions from fresh starting inputs.',
    ),
  )
  await page.screenshot({ path: `${artifacts}/comparison.png`, fullPage: true })
  await page.getByRole('button', { name: 'Explore', exact: true }).click()
  await page
    .getByLabel('Program', { exact: true })
    .selectOption({ label: 'Browser finite counter' })
  await page
    .getByRole('button', { name: 'Inspect', exact: true })
    .first()
    .waitFor()
  await page
    .getByRole('button', { name: 'Inspect', exact: true })
    .first()
    .click()
  await page.getByLabel('Selected state', { exact: true }).waitFor()
  await page
    .getByRole('button', { name: 'Continue', exact: true })
    .first()
    .click()
  await page.waitForFunction(() =>
    document.body.innerText.includes('Before heading'),
  )
  await page.goto(`${origin}/lab.html`)
  await page
    .getByRole('button', { name: 'Inspect', exact: true })
    .first()
    .waitFor()
  await page
    .getByRole('button', { name: 'Inspect', exact: true })
    .first()
    .click()
  await page.getByLabel('Selected state', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Compare', exact: true }).click()
  await page.getByLabel('Comparison', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.waitForFunction(() =>
    document.body.innerText.includes('Cancelled'),
  )
  await page.screenshot({ path: `${artifacts}/lab.png`, fullPage: true })
  assert.deepEqual(exceptions, [])
  const result = {
    status: 'passed',
    animationFrames: frames,
    exceptions,
    checks: [
      'large pruned search cancellation',
      'reset/depth/mode controls',
      'comparison preview and fresh replay',
      'live interaction and inspector',
      '/lab.html entry point',
    ],
  }
  await writeFile(
    `${artifacts}/result.json`,
    `${JSON.stringify(result, null, 2)}\n`,
  )
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  await state.page
    ?.screenshot({ path: `${artifacts}/failure.png`, fullPage: true })
    .catch(() => {})
  await writeFile(
    `${artifacts}/result.json`,
    `${JSON.stringify({ status: 'error', reason: String(error) }, null, 2)}\n`,
  )
  throw error
} finally {
  await state.browser?.close()
  server.kill('SIGTERM')
  await writeFile(`${artifacts}/vite.log`, logs.join(''))
}
