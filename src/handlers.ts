/**
 * Stars Gifts Bot — handlers.
 *
 * Назначение: бот только для выдачи Telegram gifts администратором @xyz.
 *
 * Возможности:
 * - /sendgift @user <amount> <count> — отправить gifts
 * - /gifts — список доступных gifts (с авто-обновлением из AltGram)
 * - /sync — принудительно обновить список gifts
 * - /log — последние 10 отправок
 * - /stats — статистика отправок
 * - /top — топ получателей
 * - Авто-синк gifts каждый час
 */

import { db } from './db'
import { altgram, md, type TgInlineKeyboardMarkup } from './altgram'
import type { TgCallbackQuery, TgMessage, TgUpdate, TgUser } from './types'

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'xyz').toLowerCase()
const SYNC_INTERVAL_MS = 60 * 60 * 1000  // 1 час — авто-синк gifts

// Gifts IDs — протестированы на AltGram
const GIFT_IDS_15 = ['9000000000000001', '9000000000000006']
const GIFT_IDS_25 = ['9000000000000007', '9000000000000028', '9000000000000030']
const GIFT_IDS_50 = ['9000000000000005', '9000000000000008', '9000000000000009', '9000000000000013', '9000000000000033', '9000000000000041']
const GIFT_IDS_75 = ['9000000000000031']
const GIFT_IDS_100 = ['9000000000000010', '9000000000000011', '9000000000000012', '9000000000000036', '9000000000000039']
const GIFT_IDS_500 = ['9000000000000029', '9000000000000035', '9000000000000040']
const GIFT_IDS_666 = ['9000000000000042']  // CURRENTLY UNAVAILABLE (sold out)
const GIFT_IDS_1000 = ['9000000000000037'] // CURRENTLY UNAVAILABLE (sold out)

function getGiftIdsForAmount(amount: number): string[] | null {
  switch (amount) {
    case 15: return GIFT_IDS_15
    case 25: return GIFT_IDS_25
    case 50: return GIFT_IDS_50
    case 75: return GIFT_IDS_75
    case 100: return GIFT_IDS_100
    case 500: return GIFT_IDS_500
    case 666: return GIFT_IDS_666
    case 1000: return GIFT_IDS_1000
    default: return null
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function send(
  chatId: number | string,
  text: string,
  replyMarkup?: TgInlineKeyboardMarkup,
  replyTo?: number
) {
  const { text: plain, entities } = md(text)
  return altgram.sendMessage({
    chat_id: chatId,
    text: plain,
    entities,
    reply_markup: replyMarkup,
    reply_to_message_id: replyTo,
  })
}

function isPrivate(msg: TgMessage): boolean {
  return msg.chat.type === 'private'
}

async function upsertUser(from: TgUser) {
  const isAdminFlag = from.username?.toLowerCase() === ADMIN_USERNAME
  const existing = await db.user.findUnique({ where: { tgId: String(from.id) } })
  if (!existing) {
    return db.user.create({
      data: {
        tgId: String(from.id),
        username: from.username?.toLowerCase() ?? null,
        firstName: from.first_name ?? null,
        lastName: from.last_name ?? null,
        isAdmin: isAdminFlag,
      },
    })
  }
  return db.user.update({
    where: { tgId: String(from.id) },
    data: {
      username: from.username?.toLowerCase() ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      ...(isAdminFlag || existing.isAdmin ? { isAdmin: true } : {}),
    },
  })
}

/* ------------------------------------------------------------------ */
/* Update dispatch                                                     */
/* ------------------------------------------------------------------ */

export async function handleUpdate(update: TgUpdate): Promise<void> {
  try {
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query)
      return
    }

    const msg = update.message ?? update.edited_message
    if (!msg) return
    if (update.edited_message) return

    if (msg.text) {
      await handleTextMessage(msg)
    }
  } catch (e) {
    console.error('[handler] error processing update:', update.update_id, e)
    try {
      const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id
      if (chatId) {
        const errMsg = e instanceof Error ? e.message : String(e)
        await altgram.sendMessage({
          chat_id: chatId,
          text: `❌ Ошибка: ${errMsg.slice(0, 300)}`,
        })
      }
    } catch {}
  }
}

async function handleTextMessage(msg: TgMessage) {
  const from = msg.from
  if (!from || from.is_bot) return

  if (!isPrivate(msg)) return

  const raw = (msg.text ?? '').trim()
  const senderName = from.username ? `@${from.username}` : (from.first_name || `id:${from.id}`)
  console.log(`[msg] ${senderName} (${from.id}): "${raw.slice(0, 100)}"`)

  const user = await upsertUser(from)

  const parts = raw.split(/\s+/)
  const head = parts[0] ?? ''
  const cmd = (head.split('@')[0] ?? '').toLowerCase()

  switch (cmd) {
    case '/start':
      await sendWelcome(msg, user)
      break
    case '/help':
      await sendHelp(msg, user)
      break
    case '/balance':
    case '/bal':
      await handleBalance(msg, user)
      break
    case '/give':
      await handleGive(msg, user, parts[1], parts[2])
      break
    case '/transfer':
    case '/pay':
      await handleTransfer(msg, user, parts[1], parts[2])
      break
    case '/withdraw':
      await handleWithdraw(msg, user, parts[1])
      break
    case '/sendgift':
    case '/gift':
      await handleSendGift(msg, user, parts.slice(1))
      break
    case '/gifts':
    case '/listgifts':
      await handleListGifts(msg, user)
      break
    case '/sync':
      await handleSync(msg, user)
      break
    case '/log':
      await handleLog(msg, user)
      break
    case '/stats':
      await handleStats(msg, user)
      break
    case '/top':
      await handleTop(msg, user)
      break
    case '/toprichest':
      await handleTopRichest(msg, user)
      break
    case '/listusers':
      await handleListUsers(msg, user)
      break
    default:
      if (cmd.startsWith('/')) {
        await send(msg.chat.id, '🤔 Неизвестная команда. /help — список команд.')
      }
  }
}

/* ------------------------------------------------------------------ */
/* Welcome + help                                                      */
/* ------------------------------------------------------------------ */

async function sendWelcome(msg: TgMessage, user: { username: string | null; firstName: string | null; isAdmin: boolean; balance: number }) {
  const kb: TgInlineKeyboardMarkup = {
    inline_keyboard: [
      [{ text: '🎁 Доступные gifts', callback_data: 'gifts' }],
      [{ text: '💰 Мой баланс', callback_data: 'balance' }, { text: '💸 Вывести', callback_data: 'withdraw_menu' }],
      [{ text: '📊 Статистика', callback_data: 'stats' }, { text: '📋 Лог', callback_data: 'log' }],
      [{ text: '🔄 Синк gifts', callback_data: 'sync' }, { text: '🏆 Топ получателей', callback_data: 'top' }],
    ],
  }
  await send(
    msg.chat.id,
    [
      `👋 Привет, **${user.firstName || user.username || 'друг'}**!`,
      ``,
      `🎁 **Stars Gifts Bot** — выдача подарков + экономика`,
      ``,
      `💰 **Твой баланс: ${user.balance}⭐**`,
      ``,
      `**Команды:**`,
      `• /balance — баланс`,
      `• /withdraw 500 — вывести звёзды (gift)`,
      `• /transfer @user 100 — перевести юзеру`,
      `• /sendgift @user 500 1 — отправить gift (админ)`,
      `• /gifts — список gifts`,
      ``,
      user.isAdmin ? `👑 Ты админ — можешь отправлять gifts и начислять звёзды` : `ℹ️ Юзеры могут переводить и выводить звёзды`,
    ].join('\n'),
    kb
  )
}

async function sendHelp(msg: TgMessage, user: { isAdmin: boolean }) {
  const text = [
    `📖 **Помощь**`,
    ``,
    `**Экономика (все):**`,
    `• /balance — твой баланс звёзд`,
    `• /transfer @user <amount> — перевести юзеру`,
    `  Пример: \`/transfer @rasta 100\``,
    `• /withdraw <amount> — вывести звёзды (получишь gift)`,
    `  Доступные суммы: 50, 100, 500⭐`,
    `  Пример: \`/withdraw 100\` → gift на 100⭐`,
    ``,
    `**Gifts (админ):**`,
    `• /sendgift @user <amount> <count> — отправить gift юзеру`,
    `  Пример: \`/sendgift @rasta 500 1\``,
    `• /gifts — список всех gifts`,
    `• /sync — обновить gifts из AltGram`,
    ``,
    `**Инфо:**`,
    `• /log — последние отправки`,
    `• /stats — статистика`,
    `• /top — топ получателей gifts`,
    `• /toprichest — топ по балансу`,
    `• /listusers — юзеры в БД (админ)`,
    ``,
    `**Суммы gifts:** 15, 25, 50, 75, 100, 500⭐ (666/1000 недоступны)`,
  ]
  if (user.isAdmin) {
    text.push(``, `**Админ:**`, `• /give @user <amount> — начислить звёзды`)
    text.push(`• /sendgift — отправить gift любому юзеру`)
  }
  await send(msg.chat.id, text.join('\n'))
}

/* ------------------------------------------------------------------ */
/* /sendgift — отправка подарка                                        */
/* ------------------------------------------------------------------ */

async function handleSendGift(
  msg: TgMessage,
  user: { id: string; tgId: string; username: string | null; firstName: string | null; isAdmin: boolean },
  args: string[]
) {
  if (!user.isAdmin) {
    await send(msg.chat.id, '🚫 Только админ может отправлять gifts.')
    return
  }

  // Парсим флаги: --anon, --msg "текст", --silent, --random, --all, --multi, --dry-run, --min, --max
  let anonymous = false
  let giftText: string | null = null
  let silentNotify = false
  let randomMode = false
  let allMode = false
  let dryRun = false
  let minAmount = 0
  let maxAmount = 0
  let multiAmounts: number[] = []
  const positionalArgs: string[] = []

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--anon' || a === '-a') {
      anonymous = true
    } else if (a === '--silent' || a === '-s') {
      silentNotify = true
    } else if (a === '--random' || a === '-r') {
      randomMode = true
    } else if (a === '--all') {
      allMode = true
    } else if (a === '--dry-run' || a === '-d') {
      dryRun = true
    } else if (a === '--min') {
      i++
      minAmount = parseInt(args[i] ?? '0') || 0
    } else if (a === '--max') {
      i++
      maxAmount = parseInt(args[i] ?? '0') || 0
    } else if (a === '--multi') {
      i++
      const amountsStr = args[i] ?? ''
      multiAmounts = amountsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0)
    } else if (a === '--msg' || a === '-m') {
      i++
      const msgParts: string[] = []
      while (i < args.length && !args[i].startsWith('--') && !args[i].startsWith('-')) {
        msgParts.push(args[i])
        i++
      }
      i--
      giftText = msgParts.join(' ').replace(/^["']|["']$/g, '')
    } else {
      positionalArgs.push(a)
    }
  }

  const targetArg = positionalArgs[0] ?? ''
  const amountArg = positionalArgs[1]
  const countArg = positionalArgs[2] || '1'

  const rawTarget = targetArg.replace(/^@/, '').trim()
  if (!rawTarget) {
    await send(
      msg.chat.id,
      [
        '⚠️ **Использование:**',
        '',
        '**Базовая отправка:**',
        '`/sendgift @user 500 1` — отправить 1 gift на 500⭐',
        '',
        '**Фишки:**',
        '`/sendgift @user 500 1 --anon` — 🕵️ анонимно (получатель не знает кто)',
        '`/sendgift @user 500 1 --msg "С ДР!"` — 📝 с текстом в gift',
        '`/sendgift @user 500 1 --silent` — 🤫 без уведомления в ЛС',
        '`/sendgift @user --random 3` — 🎲 3 случайных gifts',
        '`/sendgift @user --random 5 --min 50 --max 500` — 🎲 5 от 50 до 500⭐',
        '`/sendgift @user --multi 50,100,500` — 📦 gifts разных номиналов',
        '`/sendgift @user --all` — 🎉 ВСЕ доступные gifts (по 1 каждого)',
        '`/sendgift @user 500 1 --dry-run` — 🔍 предпросмотр (без отправки)',
        '',
        '**Все флаги (комбинируются):**',
        '• `--anon` / `-a` — анонимно',
        '• `--msg "текст"` / `-m` — текст к gift',
        '• `--silent` / `-s` — без уведомления',
        '• `--dry-run` / `-d` — предпросмотр',
        '• `--random` / `-r` — случайный gift',
        '• `--multi 50,100` — несколько номиналов',
        '• `--all` — все gifts',
        '• `--min N` / `--max N` — диапазон для random',
        '',
        '**Цены:** 15, 25, 50, 75, 100, 500⭐ (666/1000 недоступны)',
      ].join('\n')
    )
    return
  }

  // Найти юзера
  const target = await findOrCreateTarget(rawTarget, msg)
  if (!target) return

  const opts = { anonymous, giftText, silentNotify, dryRun }

  // Режим --all: отправить все доступные gifts
  if (allMode) {
    await handleSendAllGifts(msg, user, target, opts)
    return
  }

  // Режим --random: случайные gifts
  if (randomMode) {
    const count = parseInt(amountArg ?? '1') || 1
    await handleSendRandomGift(msg, user, target, count, { ...opts, minAmount, maxAmount })
    return
  }

  // Режим --multi: несколько номиналов
  if (multiAmounts.length > 0) {
    await handleSendMultiGifts(msg, user, target, multiAmounts, opts)
    return
  }

  // Обычный режим
  const amount = parseInt(amountArg ?? '')
  const count = Math.min(Math.max(parseInt(countArg) || 1, 1), 50)

  if (isNaN(amount) || amount <= 0) {
    await send(msg.chat.id, '⚠️ Укажи цену gift: `/sendgift @user 500 1`')
    return
  }

  const availableGift = await db.availableGift.findFirst({
    where: { starCount: amount, isActive: true, isSoldOut: false },
    orderBy: { remainingCount: 'asc' },
  })

  if (!availableGift) {
    await send(
      msg.chat.id,
      [
        `❌ Нет gifts на ${amount}⭐.`,
        ``,
        `**Доступные суммы:** 15, 25, 50, 75, 100, 500⭐`,
        `(666 и 1000 временно недоступны)`,
        `Посмотри: /gifts`,
      ].join('\n')
    )
    return
  }

  const displayName = target.username ? `@${target.username}` : `tg:${target.tgId}`
  const flagsInfo: string[] = []
  if (anonymous) flagsInfo.push('🕵️ анонимно')
  if (giftText) flagsInfo.push(`📝 "${giftText}"`)
  if (silentNotify) flagsInfo.push('🤫 без уведомления')
  if (dryRun) flagsInfo.push('🔍 dry-run')

  if (dryRun) {
    await send(msg.chat.id,
      [
        `🔍 **Предпросмотр (dry-run):**`,
        `👤 Юзер: ${displayName}`,
        `💰 ${amount}⭐ × ${count}`,
        `🎁 Gift ID: ${availableGift.giftId}`,
        ...(flagsInfo.length > 0 ? [`🏷 Флаги: ${flagsInfo.join(', ')}`] : []),
        ``,
        `⚠️ Ничего не отправлено. Убери --dry-run для реальной отправки.`,
      ].join('\n')
    )
    return
  }

  const flagsText = flagsInfo.length > 0 ? ` (${flagsInfo.join(', ')})` : ''
  await send(msg.chat.id, `⏳ Отправляю ${count} gifts по ${amount}⭐ юзеру ${displayName}${flagsText}...`)

  // Отправляем gifts
  let successCount = 0
  let failedCount = 0

  for (let i = 0; i < count; i++) {
    const gift = await db.availableGift.findFirst({
      where: { starCount: amount, isActive: true, isSoldOut: false },
    })
    if (!gift) {
      failedCount++
      continue
    }

    const giftParams: { user_id: number; gift_id: string; text?: string } = {
      user_id: Number(target.tgId),
      gift_id: gift.giftId,
    }
    if (!anonymous && giftText) {
      giftParams.text = giftText
    }

    const res = await altgram.sendGift(giftParams)

    if (res.ok) {
      successCount++
    } else {
      failedCount++
      console.error(`[sendgift] failed: ${res.description}`)
    }
  }

  // Лог в БД
  await db.giftLog.create({
    data: {
      senderTgId: user.tgId,
      recipientTgId: target.tgId,
      recipientUsername: target.username,
      amount,
      giftId: availableGift.giftId,
      count,
      successCount,
      failedCount,
      status: successCount === count ? 'success' : successCount === 0 ? 'failed' : 'partial',
      note: flagsInfo.length > 0 ? flagsInfo.join(', ') : null,
    },
  })

  await send(
    msg.chat.id,
    [
      `🎁 **Результат:**`,
      `👤 Юзер: ${displayName}`,
      `💰 ${amount}⭐ × ${count}`,
      `✅ Отправлено: ${successCount}`,
      `❌ Не удалось: ${failedCount}`,
      ...(flagsInfo.length > 0 ? [`🏷 Флаги: ${flagsInfo.join(', ')}`] : []),
    ].join('\n')
  )

  // Уведомить получателя (если не --silent)
  if (successCount > 0 && !silentNotify) {
    try {
      const senderName = anonymous ? 'аноним' : (user.username ? `@${user.username}` : (user.firstName || 'админ'))
      let notifyText = `🎁 Вам отправлено ${successCount} gifts по ${amount}⭐ от ${senderName}!`
      if (giftText && !anonymous) {
        notifyText += `\n\n💬 "${giftText}"`
      }
      await send(target.tgId, notifyText)
    } catch {}
  }
}

// Вспомогательная: найти или создать юзера
async function findOrCreateTarget(rawTarget: string, msg: TgMessage): Promise<{ tgId: string; username: string | null; firstName: string | null } | null> {
  let target: { tgId: string; username: string | null; firstName: string | null } | null = null

  if (/^\d+$/.test(rawTarget)) {
    target = await db.user.findUnique({
      where: { tgId: rawTarget },
      select: { tgId: true, username: true, firstName: true },
    })
    if (!target) {
      try {
        target = await db.user.create({ data: { tgId: rawTarget, username: null, firstName: null } })
        await send(msg.chat.id, `ℹ️ Юзер с tgId \`${rawTarget}\` добавлен в БД.`)
      } catch {
        await send(msg.chat.id, `❌ Не удалось создать юзера с tgId \`${rawTarget}\`.`)
        return null
      }
    }
  } else {
    target = await db.user.findFirst({
      where: { username: rawTarget.toLowerCase() },
      select: { tgId: true, username: true, firstName: true },
    })
  }

  if (!target) {
    await send(msg.chat.id, `❌ Юзер \`${rawTarget}\` не найден в БД.\n\nЮзер должен нажать /start боту.`)
    return null
  }
  return target
}

// Вспомогательная: отправить gifts с флагами (возвращает sent/failed)
async function sendGiftsWithFlags(
  tgId: string,
  amount: number,
  count: number,
  opts: { anonymous: boolean; giftText: string | null }
): Promise<{ sent: number; failed: number }> {
  const giftIds = getGiftIdsForAmount(amount) ?? []
  if (giftIds.length === 0) return { sent: 0, failed: count }

  let sent = 0
  let failed = 0

  for (let i = 0; i < count; i++) {
    let giftSent = false
    for (const giftId of giftIds) {
      const giftParams: { user_id: number; gift_id: string; text?: string } = {
        user_id: Number(tgId),
        gift_id: giftId,
      }
      if (!opts.anonymous && opts.giftText) {
        giftParams.text = opts.giftText
      }
      const res = await altgram.sendGift(giftParams)
      if (res.ok) {
        giftSent = true
        break
      }
    }
    if (giftSent) sent++
    else failed++
  }

  return { sent, failed }
}

// Вспомогательная: собрать инфо о флагах
function buildFlagsInfo(opts: { anonymous: boolean; giftText: string | null; silentNotify: boolean; dryRun: boolean }): string[] {
  const flags: string[] = []
  if (opts.anonymous) flags.push('🕵️ анонимно')
  if (opts.giftText) flags.push(`📝 "${opts.giftText}"`)
  if (opts.silentNotify) flags.push('🤫 без уведомления')
  if (opts.dryRun) flags.push('🔍 dry-run')
  return flags
}

// --all: отправить все доступные gifts (по 1 каждого номинала)
async function handleSendAllGifts(
  msg: TgMessage,
  user: { tgId: string; username: string | null; firstName: string | null },
  target: { tgId: string; username: string | null; firstName: string | null },
  opts: { anonymous: boolean; giftText: string | null; silentNotify: boolean; dryRun: boolean }
) {
  const gifts = await db.availableGift.findMany({
    where: { isActive: true, isSoldOut: false },
    orderBy: { starCount: 'asc' },
    distinct: ['starCount'],
  })

  if (gifts.length === 0) {
    await send(msg.chat.id, '❌ Нет доступных gifts.')
    return
  }

  const displayName = target.username ? `@${target.username}` : `tg:${target.tgId}`

  if (opts.dryRun) {
    const lines = gifts.map(g => `• ${g.starCount}⭐ (id: ${g.giftId})`)
    await send(msg.chat.id,
      [
        `🔍 **Предпросмотр --all:**`,
        `👤 Юзер: ${displayName}`,
        ``,
        `Будет отправлено ${gifts.length} gifts:`,
        ...lines,
        ``,
        `⚠️ Убери --dry-run для отправки.`,
      ].join('\n')
    )
    return
  }

  await send(msg.chat.id, `⏳ Отправляю ВСЕ ${gifts.length} gifts юзеру ${displayName}...`)

  let totalSent = 0
  let totalFailed = 0
  const details: string[] = []

  for (const gift of gifts) {
    const result = await sendGiftsWithFlags(target.tgId, gift.starCount, 1, opts)
    if (result.sent > 0) {
      totalSent++
      details.push(`✅ ${gift.starCount}⭐`)
      // Лог в БД
      await db.giftLog.create({
        data: {
          senderTgId: user.tgId,
          recipientTgId: target.tgId,
          recipientUsername: target.username,
          amount: gift.starCount,
          giftId: gift.giftId,
          count: 1,
          successCount: 1,
          failedCount: 0,
          status: 'success',
          note: '--all',
        },
      })
    } else {
      totalFailed++
      details.push(`❌ ${gift.starCount}⭐`)
    }
  }

  const flagsInfo = buildFlagsInfo(opts)
  await send(msg.chat.id,
    [
      `🎉 **Результат --all:**`,
      `👤 Юзер: ${displayName}`,
      `✅ Отправлено: ${totalSent}/${gifts.length}`,
      `❌ Не удалось: ${totalFailed}`,
      ``,
      ...details,
      ...(flagsInfo.length > 0 ? [``, `🏷 Флаги: ${flagsInfo.join(', ')}`] : []),
    ].join('\n')
  )

  if (totalSent > 0 && !opts.silentNotify) {
    try {
      const senderName = opts.anonymous ? 'аноним' : (user.username ? `@${user.username}` : (user.firstName || 'админ'))
      await send(target.tgId, `🎉 Вам отправлено ${totalSent} разных gifts от ${senderName}!`)
    } catch {}
  }
}

// --random: отправить N случайных gifts
async function handleSendRandomGift(
  msg: TgMessage,
  user: { tgId: string; username: string | null; firstName: string | null },
  target: { tgId: string; username: string | null; firstName: string | null },
  count: number,
  opts: { anonymous: boolean; giftText: string | null; silentNotify: boolean; dryRun: boolean; minAmount: number; maxAmount: number }
) {
  let gifts = await db.availableGift.findMany({
    where: { isActive: true, isSoldOut: false },
  })

  if (opts.minAmount > 0) gifts = gifts.filter(g => g.starCount >= opts.minAmount)
  if (opts.maxAmount > 0) gifts = gifts.filter(g => g.starCount <= opts.maxAmount)

  const uniqueAmounts = [...new Set(gifts.map(g => g.starCount))]

  if (uniqueAmounts.length === 0) {
    await send(msg.chat.id, '❌ Нет gifts в указанном диапазоне.')
    return
  }

  const displayName = target.username ? `@${target.username}` : `tg:${target.tgId}`

  if (opts.dryRun) {
    await send(msg.chat.id,
      [
        `🔍 **Предпросмотр --random:**`,
        `👤 Юзер: ${displayName}`,
        ``,
        `Доступные суммы: ${uniqueAmounts.join(', ')}⭐`,
        `Будет отправлено: ${count} случайных`,
        ``,
        `⚠️ Убери --dry-run для отправки.`,
      ].join('\n')
    )
    return
  }

  await send(msg.chat.id, `🎲 Отправляю ${count} случайных gifts юзеру ${displayName}...`)

  let totalSent = 0
  let totalFailed = 0
  const details: string[] = []

  for (let i = 0; i < count; i++) {
    const randomAmount = uniqueAmounts[Math.floor(Math.random() * uniqueAmounts.length)]
    const result = await sendGiftsWithFlags(target.tgId, randomAmount, 1, opts)
    if (result.sent > 0) {
      totalSent++
      details.push(`✅ ${randomAmount}⭐`)
    } else {
      totalFailed++
      details.push(`❌ ${randomAmount}⭐`)
    }
  }

  const flagsInfo = buildFlagsInfo(opts)
  await send(msg.chat.id,
    [
      `🎲 **Результат --random:**`,
      `👤 Юзер: ${displayName}`,
      `✅ Отправлено: ${totalSent}/${count}`,
      `❌ Не удалось: ${totalFailed}`,
      ``,
      ...details,
      ...(flagsInfo.length > 0 ? [``, `🏷 Флаги: ${flagsInfo.join(', ')}`] : []),
    ].join('\n')
  )

  if (totalSent > 0 && !opts.silentNotify) {
    try {
      const senderName = opts.anonymous ? 'аноним' : (user.username ? `@${user.username}` : (user.firstName || 'админ'))
      await send(target.tgId, `🎲 Вам отправлено ${totalSent} случайных gifts от ${senderName}!`)
    } catch {}
  }
}

// --multi: отправить gifts разных номиналов
async function handleSendMultiGifts(
  msg: TgMessage,
  user: { tgId: string; username: string | null; firstName: string | null },
  target: { tgId: string; username: string | null; firstName: string | null },
  amounts: number[],
  opts: { anonymous: boolean; giftText: string | null; silentNotify: boolean; dryRun: boolean }
) {
  const displayName = target.username ? `@${target.username}` : `tg:${target.tgId}`

  if (opts.dryRun) {
    await send(msg.chat.id,
      [
        `🔍 **Предпросмотр --multi:**`,
        `👤 Юзер: ${displayName}`,
        ``,
        `Будет отправлено: ${amounts.map(a => `${a}⭐`).join(', ')}`,
        ``,
        `⚠️ Убери --dry-run для отправки.`,
      ].join('\n')
    )
    return
  }

  await send(msg.chat.id, `📦 Отправляю ${amounts.length} разных gifts юзеру ${displayName}...`)

  let totalSent = 0
  let totalFailed = 0
  const details: string[] = []

  for (const amount of amounts) {
    const result = await sendGiftsWithFlags(target.tgId, amount, 1, opts)
    if (result.sent > 0) {
      totalSent++
      details.push(`✅ ${amount}⭐`)
    } else {
      totalFailed++
      details.push(`❌ ${amount}⭐`)
    }
  }

  const flagsInfo = buildFlagsInfo(opts)
  await send(msg.chat.id,
    [
      `📦 **Результат --multi:**`,
      `👤 Юзер: ${displayName}`,
      `✅ Отправлено: ${totalSent}/${amounts.length}`,
      `❌ Не удалось: ${totalFailed}`,
      ``,
      ...details,
      ...(flagsInfo.length > 0 ? [``, `🏷 Флаги: ${flagsInfo.join(', ')}`] : []),
    ].join('\n')
  )

  if (totalSent > 0 && !opts.silentNotify) {
    try {
      const senderName = opts.anonymous ? 'аноним' : (user.username ? `@${user.username}` : (user.firstName || 'админ'))
      await send(target.tgId, `📦 Вам отправлено ${totalSent} разных gifts от ${senderName}!`)
    } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* /gifts — список доступных                                           */
/* ------------------------------------------------------------------ */

async function handleListGifts(msg: TgMessage, user: { isAdmin: boolean }) {
  // Сначала обновим из AltGram
  await syncGifts()

  const gifts = await db.availableGift.findMany({
    where: { isActive: true },
    orderBy: [{ starCount: 'asc' }, { isSoldOut: 'asc' }],
  })

  if (gifts.length === 0) {
    await send(msg.chat.id, '📭 Нет доступных gifts. Попробуй /sync')
    return
  }

  // Группируем по starCount
  const grouped = new Map<number, { count: number; minRemaining: number | null; soldOut: boolean }>()
  for (const g of gifts) {
    const existing = grouped.get(g.starCount) ?? { count: 0, minRemaining: null, soldOut: true }
    existing.count++
    if (g.remainingCount !== null) {
      existing.minRemaining = existing.minRemaining === null ? g.remainingCount : Math.min(existing.minRemaining, g.remainingCount)
    }
    if (!g.isSoldOut) existing.soldOut = false
    grouped.set(g.starCount, existing)
  }

  const lines: string[] = []
  for (const [starCount, info] of grouped) {
    const status = info.soldOut ? '❌ sold out' : (info.minRemaining !== null ? `✅ ${info.minRemaining} осталось` : '✅')
    const emoji = starCount === 666 ? '👹' : '🎁'
    lines.push(`• ${emoji} **${starCount}⭐** — ${info.count} variants — ${status}`)
  }

  await send(
    msg.chat.id,
    [
      `🎁 **Доступные gifts** (${gifts.length} всего):`,
      ``,
      ...lines,
      ``,
      `Использование: \`/sendgift @user <сумма> <кол-во>\``,
    ].join('\n')
  )
}

/* ------------------------------------------------------------------ */
/* /sync — принудительная синхронизация                                */
/* ------------------------------------------------------------------ */

async function handleSync(msg: TgMessage, user: { isAdmin: boolean }) {
  await send(msg.chat.id, '🔄 Обновляю список gifts из AltGram...')
  const result = await syncGifts()
  await send(
    msg.chat.id,
    [
      `✅ **Синхронизация завершена**`,
      `📊 Всего gifts: ${result.total}`,
      `🆕 Новых: ${result.new}`,
      `♻️ Обновлено: ${result.updated}`,
      `❌ Sold out: ${result.soldOut}`,
    ].join('\n')
  )
}

export async function syncGifts(): Promise<{ total: number; new: number; updated: number; soldOut: number }> {
  const res = await altgram.getAvailableGifts()
  if (!res.ok || !res.result) {
    console.error('[sync] getAvailableGifts failed:', res.description)
    return { total: 0, new: 0, updated: 0, soldOut: 0 }
  }

  let newCount = 0
  let updatedCount = 0
  let soldOutCount = 0
  const seenIds = new Set<string>()

  for (const g of res.result.gifts) {
    const giftId = String(g.id)
    seenIds.add(giftId)

    const existing = await db.availableGift.findUnique({ where: { giftId } })
    const isSoldOut = g.is_sold_out === true || (g.remaining_count !== undefined && g.remaining_count === 0)

    if (existing) {
      await db.availableGift.update({
        where: { id: existing.id },
        data: {
          starCount: g.star_count,
          emoji: g.sticker?.emoji ?? '🎁',
          fileId: g.sticker?.file_id ?? null,
          isLimited: g.is_limited ?? false,
          isSoldOut,
          remainingCount: g.remaining_count ?? null,
          totalCount: g.total_count ?? null,
          isActive: true,
          lastCheckedAt: new Date(),
        },
      })
      updatedCount++
      if (isSoldOut) soldOutCount++
    } else {
      await db.availableGift.create({
        data: {
          giftId,
          starCount: g.star_count,
          emoji: g.sticker?.emoji ?? '🎁',
          fileId: g.sticker?.file_id ?? null,
          isLimited: g.is_limited ?? false,
          isSoldOut,
          remainingCount: g.remaining_count ?? null,
          totalCount: g.total_count ?? null,
          isActive: true,
          lastCheckedAt: new Date(),
        },
      })
      newCount++
      console.log(`[sync] NEW gift: ${g.star_count}⭐ id=${giftId}`)
    }
  }

  // Помечаем отсутствующие как неактивные
  const allGifts = await db.availableGift.findMany({ where: { isActive: true } })
  for (const g of allGifts) {
    if (!seenIds.has(g.giftId)) {
      await db.availableGift.update({ where: { id: g.id }, data: { isActive: false } })
    }
  }

  console.log(`[sync] done: total=${res.result.count}, new=${newCount}, updated=${updatedCount}, soldOut=${soldOutCount}`)
  return { total: res.result.count, new: newCount, updated: updatedCount, soldOut: soldOutCount }
}

/* ------------------------------------------------------------------ */
/* /log — последние отправки                                           */
/* ------------------------------------------------------------------ */

async function handleLog(msg: TgMessage, user: { isAdmin: boolean }) {
  if (!user.isAdmin) {
    await send(msg.chat.id, '🚫 Только админ.')
    return
  }
  const logs = await db.giftLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
  })
  if (logs.length === 0) {
    await send(msg.chat.id, '📭 Пока нет отправок.')
    return
  }
  const lines = logs.map(l => {
    const date = l.createdAt.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    const recipient = l.recipientUsername ? `@${l.recipientUsername}` : `id:${l.recipientTgId}`
    const status = l.status === 'success' ? '✅' : l.status === 'failed' ? '❌' : '⚠️'
    return `${status} ${date} → ${recipient}: ${l.amount}⭐ × ${l.count} (${l.successCount}/${l.count})`
  })
  await send(msg.chat.id, `📋 **Последние 10 отправок:**\n\n${lines.join('\n')}`)
}

/* ------------------------------------------------------------------ */
/* /stats — статистика                                                 */
/* ------------------------------------------------------------------ */

async function handleStats(msg: TgMessage, user: { isAdmin: boolean }) {
  if (!user.isAdmin) {
    await send(msg.chat.id, '🚫 Только админ.')
    return
  }
  const totalSent = await db.giftLog.aggregate({ _sum: { successCount: true } })
  const totalStars = await db.giftLog.aggregate({ _sum: { amount: true } })
  const totalLogs = await db.giftLog.count()
  const totalUsers = await db.user.count()
  const totalGifts = await db.availableGift.count({ where: { isActive: true, isSoldOut: false } })

  await send(
    msg.chat.id,
    [
      `📊 **Статистика бота**`,
      ``,
      `🎁 Отправлено gifts: **${totalSent._sum.successCount ?? 0}**`,
      `⭐ Сумма: **${totalStars._sum.amount ?? 0}⭐**`,
      `📋 Логов отправок: **${totalLogs}**`,
      `👥 Юзеров в БД: **${totalUsers}**`,
      `🛍️ Активных gifts: **${totalGifts}**`,
    ].join('\n')
  )
}

/* ------------------------------------------------------------------ */
/* /top — топ получателей                                              */
/* ------------------------------------------------------------------ */

async function handleTop(msg: TgMessage, user: { isAdmin: boolean }) {
  if (!user.isAdmin) {
    await send(msg.chat.id, '🚫 Только админ.')
    return
  }
  // Группируем по recipientTgId
  const logs = await db.giftLog.findMany({
    where: { status: { in: ['success', 'partial'] } },
    select: { recipientTgId: true, recipientUsername: true, amount: true, count: true },
  })
  if (logs.length === 0) {
    await send(msg.chat.id, '📭 Нет отправок.')
    return
  }
  const byUser = new Map<string, { total: number; username: string | null }>()
  for (const l of logs) {
    const existing = byUser.get(l.recipientTgId) ?? { total: 0, username: l.recipientUsername }
    existing.total += l.amount * l.count
    if (l.recipientUsername && !existing.username) existing.username = l.recipientUsername
    byUser.set(l.recipientTgId, existing)
  }
  const sorted = Array.from(byUser.entries())
    .map(([tgId, info]) => ({ tgId, ...info }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)

  const lines = sorted.map((u, i) => {
    const name = u.username ? `@${u.username}` : `id:${u.tgId}`
    return `${i + 1}. ${name} — ${u.total}⭐`
  })
  await send(msg.chat.id, `🏆 **Топ-10 получателей:**\n\n${lines.join('\n')}`)
}

/* ------------------------------------------------------------------ */
/* /listusers — список юзеров                                          */
/* ------------------------------------------------------------------ */

async function handleListUsers(msg: TgMessage, user: { isAdmin: boolean }) {
  if (!user.isAdmin) {
    await send(msg.chat.id, '🚫 Только админ.')
    return
  }
  const users = await db.user.findMany({
    select: { username: true, tgId: true, firstName: true, isAdmin: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 50,
  })
  const lines = users.map(u => {
    const name = u.username ? `@${u.username}` : (u.firstName || '(no name)')
    const adminTag = u.isAdmin ? ' 👑' : ''
    return `• ${name} — tgId: ${u.tgId}${adminTag}`
  })
  await send(msg.chat.id, `📋 **Юзеры в БД (${users.length}):**\n\n${lines.join('\n')}`)
}

/* ------------------------------------------------------------------ */
/* /balance — показать баланс                                          */
/* ------------------------------------------------------------------ */

async function handleBalance(msg: TgMessage, user: { balance: number; username: string | null; firstName: string | null }) {
  await send(msg.chat.id,
    [
      `💰 **Твой баланс**`,
      ``,
      `⭐ Звёзды: **${user.balance}⭐**`,
      ``,
      `**Что можно делать:**`,
      `• /transfer @user <amount> — перевести юзеру`,
      `• /withdraw <amount> — вывести (получишь gift)`,
    ].join('\n')
  )
}

/* ------------------------------------------------------------------ */
/* /give — админ начисляет звёзды юзеру                                */
/* ------------------------------------------------------------------ */

async function handleGive(
  msg: TgMessage,
  user: { tgId: string; username: string | null; firstName: string | null; isAdmin: boolean },
  targetArg?: string,
  amountArg?: string
) {
  if (!user.isAdmin) {
    await send(msg.chat.id, '🚫 Только админ.')
    return
  }
  if (!targetArg || !targetArg.startsWith('@')) {
    await send(msg.chat.id, '⚠️ Использование: `/give @user 100`')
    return
  }
  const targetUsername = targetArg.slice(1).toLowerCase()
  const amount = parseInt(amountArg ?? '')
  if (isNaN(amount) || amount <= 0) {
    await send(msg.chat.id, '⚠️ Укажи сумму: `/give @user 100`')
    return
  }
  const target = await db.user.findFirst({ where: { username: targetUsername } })
  if (!target) {
    await send(msg.chat.id, `❌ @${targetUsername} не найден. Юзер должен запустить /start.`)
    return
  }
  try {
    const updated = await db.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: target.id },
        data: { balance: { increment: amount } },
      })
      await tx.transaction.create({
        data: {
          userId: target.tgId,
          type: 'give',
          amount,
          balanceAfter: u.balance,
          note: `Начисление от @${user.username ?? 'admin'}`,
        },
      })
      return u
    })
    await send(msg.chat.id, `✅ @${targetUsername} +${amount}⭐. Баланс: ${updated.balance}⭐`)
    try {
      const senderName = user.username ? `@${user.username}` : (user.firstName || 'админ')
      await send(target.tgId, `🎁 Админ ${senderName} начислил вам ${amount}⭐!\n\nБаланс: ${updated.balance}⭐`)
    } catch {}
  } catch (e) {
    await send(msg.chat.id, `❌ Ошибка: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/* ------------------------------------------------------------------ */
/* /transfer — перевод звёзд другому юзеру                              */
/* ------------------------------------------------------------------ */

async function handleTransfer(
  msg: TgMessage,
  user: { id: string; tgId: string; username: string | null; firstName: string | null; balance: number },
  targetArg?: string,
  amountArg?: string
) {
  if (!targetArg || !targetArg.startsWith('@')) {
    await send(msg.chat.id, '⚠️ Использование: `/transfer @user 100`')
    return
  }
  const targetUsername = targetArg.slice(1).toLowerCase()
  if (targetUsername === (user.username ?? '')) {
    await send(msg.chat.id, '⚠️ Нельзя перевести себе!')
    return
  }
  const amount = parseInt(amountArg ?? '')
  if (isNaN(amount) || amount <= 0) {
    await send(msg.chat.id, '⚠️ Укажи сумму: `/transfer @user 100`')
    return
  }
  if (user.balance < amount) {
    await send(msg.chat.id, `❌ Недостаточно звёзд. Баланс: ${user.balance}⭐`)
    return
  }
  const target = await db.user.findFirst({ where: { username: targetUsername } })
  if (!target) {
    await send(msg.chat.id, `❌ @${targetUsername} не найден. Юзер должен запустить /start.`)
    return
  }

  try {
    // Атомарный перевод в транзакции
    const result = await db.$transaction(async (tx) => {
      // Списываем у отправителя
      const senderFresh = await tx.user.findUnique({ where: { id: user.id } })
      if (!senderFresh) throw new Error('sender_missing')
      if (senderFresh.balance < amount) throw new Error('insufficient_balance')
      const senderUpdated = await tx.user.update({
        where: { id: user.id },
        data: { balance: { decrement: amount } },
      })
      await tx.transaction.create({
        data: {
          userId: user.tgId,
          type: 'transfer_out',
          amount: -amount,
          balanceAfter: senderUpdated.balance,
          note: `Перевод @${targetUsername}`,
        },
      })

      // Начисляем получателю
      const recipientUpdated = await tx.user.update({
        where: { id: target.id },
        data: { balance: { increment: amount } },
      })
      await tx.transaction.create({
        data: {
          userId: target.tgId,
          type: 'transfer_in',
          amount,
          balanceAfter: recipientUpdated.balance,
          note: `От @${user.username ?? user.tgId}`,
        },
      })
      return { sender: senderUpdated, recipient: recipientUpdated }
    })

    await send(
      msg.chat.id,
      [
        `✅ **Перевод выполнен!**`,
        `👤 Кому: @${targetUsername}`,
        `💰 Сумма: ${amount}⭐`,
        `💼 Ваш баланс: ${result.sender.balance}⭐`,
      ].join('\n')
    )
    try {
      const senderName = user.username ? `@${user.username}` : (user.firstName || 'аноним')
      await send(
        target.tgId,
        [
          `💸 Вам перевод!`,
          ``,
          `👤 От: ${senderName}`,
          `💰 Сумма: ${amount}⭐`,
          `💼 Баланс: ${result.recipient.balance}⭐`,
        ].join('\n')
      )
    } catch {}
  } catch (e) {
    const err = String(e)
    if (err.includes('insufficient_balance')) {
      await send(msg.chat.id, '❌ Недостаточно звёзд. Попробуйте ещё раз.')
    } else {
      await send(msg.chat.id, `❌ Ошибка перевода: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/* ------------------------------------------------------------------ */
/* /withdraw — вывести звёзды (получить gift)                          */
/* ------------------------------------------------------------------ */

const VALID_WITHDRAW_AMOUNTS = [50, 100, 500]  // 666/1000 недоступны, 15/25/75 слишком мелкие

async function handleWithdraw(
  msg: TgMessage,
  user: { id: string; tgId: string; username: string | null; firstName: string | null; balance: number },
  amountArg?: string
) {
  const amount = parseInt(amountArg ?? '')
  if (!amount || !VALID_WITHDRAW_AMOUNTS.includes(amount)) {
    const kb: TgInlineKeyboardMarkup = {
      inline_keyboard: [
        [{ text: '💸 50⭐', callback_data: 'withdraw:50' }, { text: '💸 100⭐', callback_data: 'withdraw:100' }],
        [{ text: '💸 500⭐', callback_data: 'withdraw:500' }],
      ],
    }
    await send(msg.chat.id,
      [
        `💸 **Вывод звёзд через Telegram Gift**`,
        ``,
        `Подарок придёт сразу!`,
        `Доступные суммы: ${VALID_WITHDRAW_AMOUNTS.join(', ')}⭐`,
      ].join('\n'),
      kb
    )
    return
  }

  if (user.balance < amount) {
    await send(msg.chat.id, `❌ Недостаточно звёзд. Баланс: ${user.balance}⭐`)
    return
  }

  // Атомарное списание
  try {
    await db.$transaction(async (tx) => {
      const fresh = await tx.user.findUnique({ where: { id: user.id } })
      if (!fresh) throw new Error('user_missing')
      if (fresh.balance < amount) throw new Error('insufficient_balance')
      const u = await tx.user.update({
        where: { id: user.id },
        data: { balance: { decrement: amount } },
      })
      await tx.transaction.create({
        data: {
          userId: user.tgId,
          type: 'withdraw',
          amount: -amount,
          balanceAfter: u.balance,
          note: `Вывод ${amount}⭐ через gift`,
        },
      })
    })
  } catch (e) {
    const err = String(e)
    if (err.includes('insufficient_balance')) {
      await send(msg.chat.id, '❌ Недостаточно звёзд.')
      return
    }
    await send(msg.chat.id, '❌ Ошибка списания.')
    return
  }

  // Отправляем gift
  const giftIds = getGiftIdsForAmount(amount) ?? []
  let sentGiftId = ''
  if (giftIds.length === 0) {
    // Возврат
    await db.user.update({ where: { id: user.id }, data: { balance: { increment: amount } } })
    await send(msg.chat.id, '❌ Нет gifts для этой суммы. Звёзды возвращены.')
    return
  }

  let giftSent = false
  for (const giftId of giftIds) {
    const res = await altgram.sendGift({
      user_id: Number(user.tgId),
      gift_id: giftId,
    })
    if (res.ok) {
      giftSent = true
      sentGiftId = giftId
      break
    }
  }

  if (giftSent) {
    await db.giftLog.create({
      data: {
        senderTgId: user.tgId,
        recipientTgId: user.tgId,
        recipientUsername: user.username,
        amount,
        giftId: sentGiftId,
        count: 1,
        successCount: 1,
        failedCount: 0,
        status: 'success',
        note: 'Вывод через /withdraw',
      },
    })
    await send(msg.chat.id, `✅ **Вывод выполнен!**\n🎁 Подарок на ${amount}⭐ отправлен!`)
  } else {
    // Возврат звёзд
    await db.user.update({ where: { id: user.id }, data: { balance: { increment: amount } } })
    await send(msg.chat.id, '❌ Не удалось отправить подарок. Звёзды возвращены.')
  }
}

/* ------------------------------------------------------------------ */
/* /toprichest — топ по балансу                                        */
/* ------------------------------------------------------------------ */

async function handleTopRichest(msg: TgMessage, user: { isAdmin: boolean }) {
  const users = await db.user.findMany({
    where: { balance: { gt: 0 } },
    orderBy: { balance: 'desc' },
    take: 10,
    select: { username: true, firstName: true, tgId: true, balance: true },
  })
  if (users.length === 0) {
    await send(msg.chat.id, '📭 Нет юзеров с балансом > 0.')
    return
  }
  const lines = users.map((u, i) => {
    const name = u.username ? `@${u.username}` : (u.firstName || `id:${u.tgId}`)
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`
    return `${medal} ${name} — ${u.balance}⭐`
  })
  await send(msg.chat.id, `🏆 **Топ-10 богачей:**\n\n${lines.join('\n')}`)
}

/* ------------------------------------------------------------------ */
/* Callback handler                                                    */
/* ------------------------------------------------------------------ */

async function handleCallbackQuery(cq: TgCallbackQuery) {
  try {
    const data = cq.data ?? ''
    const from = cq.from
    if (!from) {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: 'Ошибка' }) } catch {}
      return
    }

    const user = await upsertUser(from)
    let act = data
    let arg = ''
    if (data.includes(':')) [act, arg] = data.split(':')

    console.log(`[callback] data="${data}" → act="${act}"`)

    const fakeMsg: TgMessage = {
      message_id: 0,
      from,
      chat: { id: from.id, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text: '',
    }

    if (act === 'gifts') {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '🎁' }) } catch {}
      await handleListGifts(fakeMsg, user)
    } else if (act === 'sync') {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '🔄' }) } catch {}
      await handleSync(fakeMsg, user)
    } else if (act === 'log') {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '📋' }) } catch {}
      await handleLog(fakeMsg, user)
    } else if (act === 'stats') {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '📊' }) } catch {}
      await handleStats(fakeMsg, user)
    } else if (act === 'top') {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '🏆' }) } catch {}
      await handleTop(fakeMsg, user)
    } else if (act === 'balance') {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '💰' }) } catch {}
      await handleBalance(fakeMsg, user)
    } else if (act === 'withdraw_menu') {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '💸' }) } catch {}
      await handleWithdraw(fakeMsg, user, '')
    } else if (act === 'withdraw') {
      const amount = parseInt(arg)
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: `💸 ${amount}⭐` }) } catch {}
      await handleWithdraw(fakeMsg, user, String(amount))
    } else {
      try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: 'Ок' }) } catch {}
    }
  } catch (e) {
    console.error('[callback] error:', e)
    try { await altgram.answerCallbackQuery({ callback_query_id: cq.id, text: '❌ Ошибка' }) } catch {}
  }
}
