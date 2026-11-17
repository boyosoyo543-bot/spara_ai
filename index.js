import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
  downloadMediaMessage, normalizeMessageContent
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'

const logger = pino({ level: 'silent' })
const DATA_DIR = process.env.DATA_DIR || './data'
fs.mkdirSync(DATA_DIR, { recursive: true })
const AUTH_DIR = process.env.AUTH_DIR || path.join(DATA_DIR, 'auth')
const CHATS_FILE = path.join(DATA_DIR, 'chats.json')
const SUBS_FILE = path.join(DATA_DIR, 'subs.json')
const PROMPT = fs.readFileSync('./prompt.txt', 'utf8')

const API_KEY = (process.env.GROQ_API_KEY || '').trim()
const TEXT_MODELS = (process.env.GROQ_MODELS || 'openai/gpt-oss-120b,openai/gpt-oss-20b')
  .split(',').map(s => s.trim()).filter(Boolean)
const SEARCH_MODEL = (process.env.GROQ_SEARCH_MODEL || 'groq/compound').trim()
const SEARCH_ON = (process.env.SEARCH || 'on').trim() !== 'off'
const VISION_MODEL = (process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b').trim()
const STT_MODEL = (process.env.GROQ_STT_MODEL || 'whisper-large-v3').trim()
const REASONING = (process.env.REASONING_EFFORT || 'medium').trim() // low | medium | high
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 5000)
const HISTORY_LIMIT = 12
const DIGEST_HOUR = Number(process.env.DIGEST_HOUR || 8) // الساعة (توقيت المغرب)
const DEFAULT_TOPICS = process.env.DIGEST_TOPICS || 'أخبار المغرب، أخبار العالم، الرياضة، التكنولوجيا'
// اختياري: نمر مسموح لها فالخاص (أرقام فقط، مفرقة بفاصلة). فارغ = الكل.
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '')
  .split(',').map(s => s.replace(/\D/g, '')).filter(Boolean)

const FAIL = 'السيرفر مشغول دابا، عاود المحاولة من بعد شوية 🙏'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const userPart = j => j?.split('@')[0].split(':')[0]

const SUB_CMDS = ['/نشرة', '/نشره', '/newsletter', '/digest']
const UNSUB_CMDS = ['/ايقاف', '/إيقاف', '/stop']
const NEWS_CMDS = ['/اخبار', '/أخبار', '/news']

// ---------- حفظ الملفات ----------
function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return {} }
}
let chats = loadJson(CHATS_FILE)
let subs = loadJson(SUBS_FILE)
let saveTimer
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(CHATS_FILE, JSON.stringify(chats)) }
    catch (e) { console.log('save failed:', e.message) }
  }, 2000)
}
function saveSubs() {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subs)) }
  catch (e) { console.log('subs save failed:', e.message) }
}
function pushHistory(jid, role, content) {
  const arr = (chats[jid] ||= [])
  arr.push({ role, content: String(content).slice(0, 3000) })
  while (arr.length > HISTORY_LIMIT) arr.shift()
  save()
}

// ---------- الوقت فالمغرب ----------
function casa() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Casablanca', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date())
  const g = t => p.find(x => x.type === t).value
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) }
}

// ---------- حد الاستعمال (30 رسالة فـ 10 دقايق لكل واحد) ----------
const hits = new Map()
function limited(id) {
  const now = Date.now()
  const arr = (hits.get(id) || []).filter(t => now - t < 10 * 60 * 1000)
  arr.push(now)
  hits.set(id, arr)
  return arr.length > 30
}

// ---------- تقسيم الجواب الطويل ----------
function chunks(text, max = 3500) {
  const out = []
  let cur = ''
  for (const para of text.split('\n\n')) {
    if (cur && (cur + '\n\n' + para).length > max) { out.push(cur); cur = '' }
    if (para.length > max) {
      for (let i = 0; i < para.length; i += max) out.push(para.slice(i, i + max))
    } else {
      cur = cur ? cur + '\n\n' + para : para
    }
  }
  if (cur) out.push(cur)
  return out
}

// ---------- طلب النشرة ----------
const digestPrompt = topics =>
  `ابحث دابا فالأنترنت واعمل ليا نشرة أخبار اليوم. المواضيع: ${topics}.\n` +
  `القواعد: غير الأحداث الجديدة (آخر 24 ساعة)، من 6 لـ 8 نقط مرتبة بالأهمية. ` +
  `كل نقطة: عنوان بالخط الغليظ، وسطرين بالكثير، ومن بعد اسم المصدر. ` +
  `ما تخترعش شي حاجة، وإلا ما لقيتيش جديد فموضوع، قولها. بالدارجة المغربية. ` +
  `فالآخر عطي جملة وحدة: شنو أهم حاجة اليوم.`

// ---------- Groq ----------
async function callGroq(model, messages, search = false) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const body = { model, messages, temperature: 0.6, max_completion_tokens: MAX_TOKENS }
      if (model.includes('gpt-oss')) {
        body.reasoning_effort = REASONING
        if (search) {
          body.tools = [{ type: 'browser_search' }]
          body.tool_choice = 'auto'
        }
      }
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify(body)
      })
      const data = await res.json()
      if (res.ok) {
        const out = data?.choices?.[0]?.message?.content?.trim()
        if (out) return out
      }
      console.log('GROQ ERROR', model, search ? '(search)' : '', res.status, JSON.stringify(data).slice(0, 300))
      if (![429, 500, 502, 503].includes(res.status)) break
    } catch (e) {
      console.log('GROQ FETCH ERROR', model, e.message)
    }
    await sleep(2000 * attempt)
  }
  return null
}

async function askAI(jid, userText, images) {
  if (!API_KEY) {
    console.log('GROQ ERROR: GROQ_API_KEY is missing')
    return null
  }
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Casablanca' })
  const system = { role: 'system', content: `${PROMPT}\n\nالتاريخ والوقت الحالي (المغرب): ${now}` }
  const past = chats[jid] || []
  let out = null

  if (images.length) {
    const content = [
      { type: 'text', text: userText || 'شنو كاين فهاد الصورة؟ حللها بالتفصيل.' },
      ...images.slice(0, 3).map(b => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${b.toString('base64')}` }
      }))
    ]
    out = await callGroq(VISION_MODEL, [system, ...past, { role: 'user', content }])
  } else {
    const msgs = [system, ...past, { role: 'user', content: userText }]
    if (SEARCH_ON) {
      for (const model of TEXT_MODELS) {
        out = await callGroq(model, msgs, true)
        if (out) break
      }
      if (!out && SEARCH_MODEL) out = await callGroq(SEARCH_MODEL, msgs)
    }
    if (!out) {
      for (const model of TEXT_MODELS) {
        out = await callGroq(model, msgs)
        if (out) break
      }
    }
  }
  if (out) {
    pushHistory(jid, 'user', images.length ? `${userText} [صورة]` : userText)
    pushHistory(jid, 'assistant', out)
  }
  return out
}

async function transcribe(buf) {
  try {
    const form = new FormData()
    form.append('file', new Blob([buf], { type: 'audio/ogg' }), 'voice.ogg')
    form.append('model', STT_MODEL)
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: form
    })
    const data = await res.json()
    if (!res.ok) {
      console.log('STT ERROR', res.status, JSON.stringify(data).slice(0, 300))
      return null
    }
    return data?.text?.trim() || null
  } catch (e) {
    console.log('STT FETCH ERROR', e.message)
    return null
  }
}

// ---------- البوت ----------
let currentSock = null
let connected = false

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({ version, auth: state, logger })
  currentSock = sock
  let asked = false

  const myIds = () => [sock.user?.id, sock.user?.lid].filter(Boolean).map(userPart)

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !asked && !sock.authState.creds.registered && process.env.PHONE) {
      asked = true
      try {
        const code = await sock.requestPairingCode(process.env.PHONE)
        console.log('PAIRING CODE:', code)
      } catch (e) {
        console.log('pairing error:', e.message)
        asked = false
      }
    }
    if (connection === 'open') {
      connected = true
      console.log('Bot connected')
    }
    if (connection === 'close') {
      connected = false
      const code = lastDisconnect?.error?.output?.statusCode
      console.log('connection closed, code:', code)
      if (code !== DisconnectReason.loggedOut) setTimeout(start, 3000)
      else console.log('logged out, change AUTH_DIR and relink')
    }
  })

  const getMedia = (msgObj, key) =>
    downloadMediaMessage(
      { key, message: msgObj }, 'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage }
    )

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue
        const jid = m.key.remoteJid
        if (!jid || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue
        const isGroup = jid.endsWith('@g.us')

        const msg = normalizeMessageContent(m.message)
        if (!msg) continue
        const ext = msg.extendedTextMessage
        const img = msg.imageMessage
        const aud = msg.audioMessage
        const text = msg.conversation || ext?.text || img?.caption || ''
        const ctx = ext?.contextInfo || img?.contextInfo || aud?.contextInfo
        const name = m.pushName || 'مستخدم'
        const senderId = isGroup ? m.key.participant : jid

        // فالخاص: لائحة مسموحين (اختياري)
        if (!isGroup && ALLOWED_USERS.length) {
          const ids = [jid, m.key.remoteJidAlt].filter(Boolean)
            .map(x => userPart(x).replace(/\D/g, ''))
          if (!ids.some(i => ALLOWED_USERS.includes(i))) {
            console.log('BLOCKED private chat:', ids.join(','))
            continue
          }
        }

        // فالجروب: غير فاش يتاغ البوت ولا يتجاوب على رسالة ديالو
        const me = myIds()
        if (isGroup) {
          const mentioned = (ctx?.mentionedJid || []).some(j => me.includes(userPart(j)))
          const repliedToBot = ctx?.participant && me.includes(userPart(ctx.participant))
          if (!mentioned && !repliedToBot) continue
        }

        const clean = text.replace(/@\d+/g, '').trim()
        const [cmd, ...rest] = clean.split(/\s+/)
        const arg = rest.join(' ').trim()
        let forcedText = null

        if (clean === '/reset') {
          delete chats[jid]
          save()
          await sock.sendMessage(jid, { text: '🧹 تمسح السجل. نبداو من الأول.' }, { quoted: m })
          continue
        }

        // أوامر النشرة
        if (SUB_CMDS.includes(cmd)) {
          const topics = arg || DEFAULT_TOPICS
          subs[jid] = { topics, last: casa().date }
          saveSubs()
          await sock.sendMessage(jid, {
            text:
              `✅ تسجلتي فالنشرة اليومية.\n` +
              `غادي توصلك كل صباح على الساعة ${DIGEST_HOUR}:00 (توقيت المغرب)، ابتداء من غدا.\n\n` +
              `*المواضيع:* ${topics}\n\n` +
              `- بدل المواضيع: /نشرة رياضة وتقنية\n` +
              `- أخبار دابا: /اخبار\n` +
              `- إيقاف: /ايقاف`
          }, { quoted: m })
          continue
        }
        if (UNSUB_CMDS.includes(cmd)) {
          delete subs[jid]
          saveSubs()
          await sock.sendMessage(jid, { text: '🛑 تحيدات النشرة اليومية.' }, { quoted: m })
          continue
        }
        if (NEWS_CMDS.includes(cmd)) {
          forcedText = digestPrompt(arg || subs[jid]?.topics || DEFAULT_TOPICS)
        }

        if (limited(senderId || jid)) {
          await sock.sendMessage(jid, { text: 'بشوية شوية 😅 بزاف د الرسائل، عاود من بعد شوية.' }, { quoted: m })
          continue
        }

        let userText = forcedText || clean
        let transcript = null
        const images = []
        const q = ctx?.quotedMessage
        const qKey = ctx?.stanzaId
          ? { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }
          : null

        try {
          if (img) images.push(await getMedia(msg, m.key))
          else if (q?.imageMessage && qKey) images.push(await getMedia(q, qKey))
          if (aud) {
            transcript = await transcribe(await getMedia(msg, m.key))
            if (!transcript) {
              await sock.sendMessage(jid, { text: 'ما قدرتش نسمع الصوتية. عاود صيفطها ولا كتب لي.' }, { quoted: m })
              continue
            }
            userText = transcript
          }
        } catch (e) {
          console.log('media failed:', e.message)
        }

        if (!userText && !images.length) continue

        const quotedText = q?.conversation || q?.extendedTextMessage?.text
        if (quotedText && !forcedText) userText = `[رسالة مقتبسة: ${quotedText}]\n${userText}`
        if (isGroup && !forcedText) userText = `${name}: ${userText}`

        await sock.sendPresenceUpdate('composing', jid)
        const reply = await askAI(jid, userText, images)
        await sock.sendPresenceUpdate('paused', jid)

        let out = reply || FAIL
        if (transcript) out = `🎙️ سمعت: «${transcript}»\n\n${out}`
        const parts = chunks(out)
        for (const [i, part] of parts.entries()) {
          await sock.sendMessage(jid, { text: part }, i === 0 ? { quoted: m } : {})
          if (i < parts.length - 1) await sleep(700)
        }
      } catch (e) {
        console.log('message error:', e.message)
      }
    }
  })
}

// ---------- جدولة النشرة اليومية ----------
let digestBusy = false
setInterval(async () => {
  if (digestBusy || !connected || !currentSock) return
  const { date, hour } = casa()
  if (hour < DIGEST_HOUR) return
  const now = Date.now()
  const due = Object.entries(subs).filter(
    ([, s]) => s.last !== date && (!s.retryAt || s.retryAt < now)
  )
  if (!due.length) return

  digestBusy = true
  try {
    for (const [jid, s] of due) {
      try {
        const text = await askAI(jid, digestPrompt(s.topics || DEFAULT_TOPICS), [])
        if (!text) {
          s.retryAt = Date.now() + 10 * 60 * 1000
          saveSubs()
          continue
        }
        const parts = chunks(`🗞️ *نشرة اليوم*\n\n${text}`)
        for (const part of parts) {
          await currentSock.sendMessage(jid, { text: part })
          await sleep(700)
        }
        s.last = date
        delete s.retryAt
        saveSubs()
      } catch (e) {
        console.log('digest error:', jid, e.message)
        s.retryAt = Date.now() + 10 * 60 * 1000
        saveSubs()
      }
      await sleep(3000)
    }
  } finally {
    digestBusy = false
  }
}, 60 * 1000)

start()
