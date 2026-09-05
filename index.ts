/**
 * Stars Gifts Bot — entry point.
 * Бот только для выдачи Telegram gifts администратором.
 * Авто-синк gifts из AltGram каждый час.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { altgram } from './src/altgram'
import { handleUpdate, syncGifts } from './src/handlers'
import { db } from './src/db'
import type { TgUpdate, TgUser } from './src/types'

const PORT = Number(process.env.PORT) || 3010
const POLL_TIMEOUT = 30
const RETRY_MS = 2000
const OFFSET_FILE = `${import.meta.dir}/.offset.json`
const SYNC_INTERVAL_MS = 60 * 60 * 1000  // 1 час

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function readPersistedOffset(): number {
  try {
    if (!existsSync(OFFSET_FILE)) return 0
    const raw = JSON.parse(readFileSync(OFFSET_FILE, 'utf8')) as { offset?: string | number }
    const offset = typeof raw.offset === 'string' ? Number(raw.offset) : raw.offset
    if (typeof offset === 'number' && offset > 0) return offset
  } catch { return 0 }
  return 0
}

function persistOffset(offset: number): void {
  try { writeFileSync(OFFSET_FILE, JSON.stringify({ offset: String(offset) })) } catch {}
}

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/' || path === '/health') {
      return new Response('OK: gifts-bot running\n', { headers: { 'Content-Type': 'text/plain' } })
    }
    return new Response('Not Found', { status: 404 })
  },
})
console.log(`[gifts-bot] health-check server listening on port ${server.port}`)

async function main() {
  if (!process.env.BOT_TOKEN) {
    console.error('[gifts-bot] FATAL: BOT_TOKEN is not set')
    process.exit(1)
  }

  let me: TgUser | null = null
  for (let i = 0; i < 10; i++) {
    const res = await altgram.getMe()
    if (res.ok && res.result) { me = res.result; break }
    console.error(`[gifts-bot] getMe failed (attempt ${i + 1})`)
    await sleep(RETRY_MS)
  }
  if (!me) { console.error('[gifts-bot] Could not authorize'); return }
  console.log(`[gifts-bot] authorized as @${me.username} (id=${me.id})`)

  try { await altgram.deleteWebhook() } catch {}
  console.log(`[gifts-bot] deleteWebhook ok`)

  await altgram.setMyCommands([
    { command: 'start', description: 'Запустить бота' },
    { command: 'sendgift', description: 'Отправить gift: /sendgift @user 500 1' },
    { command: 'gifts', description: 'Список доступных gifts' },
    { command: 'sync', description: 'Обновить gifts из AltGram' },
    { command: 'log', description: 'Последние отправки' },
    { command: 'stats', description: 'Статистика' },
    { command: 'top', description: 'Топ получателей' },
    { command: 'listusers', description: '[админ] Юзеры в БД' },
    { command: 'help', description: 'Помощь' },
  ])
  console.log(`[gifts-bot] setMyCommands ok`)

  console.log(`Bot started as @${me.username}, polling AltGram…`)

  // Проверка БД + начальный синк gifts
  try {
    const userCount = await db.user.count()
    const giftCount = await db.availableGift.count()
    console.log(`[db] Подключено. Юзеров: ${userCount}, gifts: ${giftCount}`)
    
    // Синк при старте
    console.log('[startup] syncing gifts...')
    const syncResult = await syncGifts()
    console.log(`[startup] sync done: ${syncResult.total} gifts (${syncResult.new} new)`)
  } catch (e) {
    console.error(`[db] ОШИБКА:`, e)
    throw e
  }

  // Cron: синк gifts каждый час
  ;(async () => {
    while (true) {
      await sleep(SYNC_INTERVAL_MS)
      try {
        console.log('[cron] syncing gifts...')
        const r = await syncGifts()
        console.log(`[cron] sync done: ${r.total} gifts (${r.new} new)`)
      } catch (e) {
        console.error('[cron] sync error:', e)
      }
    }
  })()

  let offsetStr = String(readPersistedOffset())
  console.log(`[gifts-bot] polling from offset=${offsetStr}`)

  let handled = 0

  while (true) {
    try {
      const apiUrl = `${process.env.ALTGRAM_API_URL || 'http://188.134.95.254:2610'}/bot${process.env.BOT_TOKEN}/getUpdates`
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: `{"offset":${offsetStr},"timeout":${POLL_TIMEOUT},"allowed_updates":["message","callback_query","edited_message"]}`,
      })

      if (!res.ok) {
        console.error(`[poll] HTTP ${res.status}, retrying...`)
        await sleep(RETRY_MS)
        continue
      }

      const data = await res.json() as { ok: boolean; result?: TgUpdate[]; error_code?: number; description?: string }
      if (!data.ok) {
        const errorCode = data.error_code || 0
        if (errorCode === 409) {
          console.log('[poll] 409 Conflict. Waiting 60s...')
          await sleep(60_000)
        } else {
          console.error('[poll] failed:', data.error_code, data.description)
          await sleep(RETRY_MS)
        }
        continue
      }

      const updates: TgUpdate[] = data.result ?? []
      for (const u of updates) {
        try {
          offsetStr = String(BigInt(u.update_id) + 1n)
          persistOffset(Number(offsetStr))
          handled++
          await handleUpdate(u)
        } catch (e) {
          console.error('[poll] handler error:', u.update_id, e)
        }
      }

      if (updates.length > 0) {
        console.log(`[poll] processed ${updates.length} update(s), offset=${offsetStr}, total=${handled}`)
      }
    } catch (e) {
      const errMsg = String(e)
      if (errMsg.includes('ConnectionRefused') || errMsg.includes('ECONNRESET') || errMsg.includes('Unable to connect')) {
        console.error('[poll] AltGram unreachable, waiting 15s...')
        await sleep(15_000)
      } else {
        console.error('[poll] error:', e)
        await sleep(RETRY_MS * 2)
      }
    }
  }
}

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[gifts-bot] received ${signal}, shutting down…`)
  server.stop(true)
  setTimeout(() => process.exit(0), 500).unref?.()
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGPIPE', () => {})

main().catch(async (e) => {
  console.error('[gifts-bot] fatal error:', e)
  console.log('[gifts-bot] restarting in 10 seconds...')
  await sleep(10_000)
  main().catch((e2) => {
    console.error('[gifts-bot] second fatal:', e2)
    process.exit(1)
  })
})

process.on('unhandledRejection', (r) => console.error('[gifts-bot] unhandledRejection:', r))
process.on('uncaughtException', (e) => console.error('[gifts-bot] uncaughtException:', e))
