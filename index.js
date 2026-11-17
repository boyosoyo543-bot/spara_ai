import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  normalizeMessageContent
} from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'fs'
import sharp from 'sharp'
import { PDFDocument } from 'pdf-lib'

const AUTH_DIR = process.env.AUTH_DIR || './auth'
const PHONE = (process.env.PHONE || '').replace(/[^0-9]/g, '')
const PDF_PAGE_SIZE = (
  process.env.PDF_PAGE_SIZE || 'A4'
).toUpperCase()

const UPSCALE_FACTOR = Math.min(
  2,
  Math.max(
    1,
    Number.parseFloat(
      process.env.UPSCALE_FACTOR || '2'
    ) || 2
  )
)

const logger = pino({ level: 'silent' })

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms))

function ensureDirectories() {
  fs.mkdirSync(AUTH_DIR, {
    recursive: true
  })
}

function getMessageContent(message) {
  return (
    normalizeMessageContent(message.message) ||
    message.message
  )
}

function getImageMedia(content) {
  // صورة عادية من Gallery
  if (content?.imageMessage) {
    return content.imageMessage
  }

  // صورة مرسلة كـDocument
  const document = content?.documentMessage

  if (!document) {
    return null
  }

  const mime = (
    document.mimetype || ''
  )
    .split(';')[0]
    .toLowerCase()

  const name = (
    document.fileName || ''
  ).toLowerCase()

  const isImage =
    mime.startsWith('image/') ||
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg') ||
    name.endsWith('.png') ||
    name.endsWith('.webp')

  return isImage ? document : null
}

function getPageSize() {
  if (PDF_PAGE_SIZE === 'LETTER') {
    return [612, 792]
  }

  if (PDF_PAGE_SIZE === 'ORIGINAL') {
    return null
  }

  // A4 هو الافتراضي
  return [595.28, 841.89]
}

function fitInside(
  width,
  height,
  maxWidth,
  maxHeight
) {
  const scale = Math.min(
    maxWidth / width,
    maxHeight / height
  )

  return {
    width: width * scale,
    height: height * scale
  }
}

async function downloadImage(
  message,
  sock
) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(
          'تحميل الصورة خذا وقت طويل بزاف، عاود صيفطها من فضلك.'
        )
      )
    }, 30000)
  })

  const download =
    downloadMediaMessage(
      message,
      'buffer',
      {},
      {
        logger,

        // إعادة طلب رابط الصورة إذا كان منتهي
        reuploadRequest: oldMessage =>
          sock.updateMediaMessage(oldMessage)
      }
    )

  return Promise.race([
    download,
    timeout
  ])
}

async function enhanceImage(
  inputBuffer
) {
  const source = sharp(
    inputBuffer,
    {
      failOn: 'none'
    }
  )

  const metadata =
    await source.metadata()

  const sourceWidth =
    metadata.width || 1600

  const sourceHeight =
    metadata.height || 1200

  const targetWidth =
    Math.round(
      sourceWidth * UPSCALE_FACTOR
    )

  const targetHeight =
    Math.round(
      sourceHeight * UPSCALE_FACTOR
    )

  // تحسين محلي مجاني:
  // تصحيح الاتجاه
  // تحسين contrast والإضاءة
  // زيادة الحدة
  // تكبير الصورة باستعمال Lanczos
  return source
    .rotate()
    .normalize()
    .sharpen({
      sigma: 1.1,
      m1: 0.7,
      m2: 2.0
    })
    .resize({
      width: targetWidth,
      height: targetHeight,
      fit: 'inside',
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: false
    })
    // PNG lossless قبل إدخالها إلى PDF
    .png({
      compressionLevel: 9,
      adaptiveFiltering: true
    })
    .toBuffer()
}

async function createPdfFromEnhancedImage(
  imageBuffer
) {
  const pdfDoc =
    await PDFDocument.create()

  pdfDoc.setTitle(
    'Enhanced WhatsApp Image'
  )

  pdfDoc.setProducer(
    'WhatsApp Local Image Enhancement Bot'
  )

  const image =
    await pdfDoc.embedPng(
      imageBuffer
    )

  const dimensions =
    image.scale(1)

  const pageSize =
    getPageSize()

  // الصفحة بنفس أبعاد الصورة المحسنة
  if (!pageSize) {
    const page = pdfDoc.addPage([
      dimensions.width,
      dimensions.height
    ])

    page.drawImage(image, {
      x: 0,
      y: 0,
      width: dimensions.width,
      height: dimensions.height
    })
  } else {
    const [
      pageWidth,
      pageHeight
    ] = pageSize

    const fitted =
      fitInside(
        dimensions.width,
        dimensions.height,
        pageWidth,
        pageHeight
      )

    const page = pdfDoc.addPage([
      pageWidth,
      pageHeight
    ])

    page.drawImage(image, {
      x:
        (pageWidth - fitted.width) / 2,
      y:
        (pageHeight - fitted.height) / 2,
      width: fitted.width,
      height: fitted.height
    })
  }

  const bytes =
    await pdfDoc.save({
      useObjectStreams: true
    })

  return Buffer.from(bytes)
}

async function start() {
  ensureDirectories()

  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(
    AUTH_DIR
  )

  const {
    version
  } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger
  })

  let pairingRequested = false

  sock.ev.on(
    'creds.update',
    saveCreds
  )

  sock.ev.on(
    'connection.update',
    async ({
      connection,
      lastDisconnect,
      qr
    }) => {
      if (
        qr &&
        !pairingRequested &&
        !sock.authState.creds.registered &&
        PHONE
      ) {
        pairingRequested = true

        try {
          const code =
            await sock.requestPairingCode(
              PHONE
            )

          console.log(
            'PAIRING CODE:',
            code
          )
        } catch (error) {
          console.log(
            'PAIRING ERROR:',
            error.message
          )

          pairingRequested = false
        }
      }

      if (connection === 'open') {
        console.log('Bot connected')
      }

      if (connection === 'close') {
        const code =
          lastDisconnect?.error?.output?.statusCode

        console.log(
          'Connection closed, code:',
          code
        )

        if (
          code !== DisconnectReason.loggedOut
        ) {
          await sleep(3000)
          start()
        } else {
          console.log(
            'Logged out. Change AUTH_DIR and relink.'
          )
        }
      }
    }
  )

  sock.ev.on(
    'messages.upsert',
    async ({ messages }) => {
      for (const message of messages) {
        try {
          if (
            !message.message ||
            message.key.fromMe
          ) {
            continue
          }

          const chatId =
            message.key.remoteJid

          // الخدمة خاصة فقط
          if (chatId.endsWith('@g.us')) {
            continue
          }

          const content =
            getMessageContent(message)

          const image =
            getImageMedia(content)

          if (!image) {
            const text = (
              content?.conversation ||
              content?.extendedTextMessage?.text ||
              ''
            )
              .trim()
              .toLowerCase()

            if (text === 'pdf') {
              await sock.sendMessage(
                chatId,
                {
                  text:
                    'صيفط ليا صورة، وأنا نحسنها ونحولها مباشرة لـPDF.'
                }
              )
            }

            continue
          }

          await sock.sendMessage(
            chatId,
            {
              text:
                '⏳ توصلت بالصورة، كنحسن الجودة ونوجد لك PDF...'
            }
          )

          const originalBuffer =
            await downloadImage(
              message,
              sock
            )

          const enhancedBuffer =
            await enhanceImage(
              originalBuffer
            )

          const pdfBuffer =
            await createPdfFromEnhancedImage(
              enhancedBuffer
            )

          await sock.sendMessage(
            chatId,
            {
              document: pdfBuffer,
              mimetype: 'application/pdf',
              fileName:
                `enhanced-image-${Date.now()}.pdf`,
              caption:
                '✅ تفضل، حسنت الصورة وحولتها لـPDF.'
            }
          )

          await sock.sendMessage(
            chatId,
            {
              text:
                'شكراً لاستعمال الخدمة. التحسين محلي ومجاني، وقد لا يرجع التفاصيل التي ضاعت نهائياً بسبب ضغط WhatsApp.'
            }
          )
        } catch (error) {
          console.log(
            'MESSAGE ERROR:',
            error.message
          )

          try {
            await sock.sendMessage(
              message.key.remoteJid,
              {
                text:
                  `ماقدرتش نحسن الصورة دابا. ` +
                  `السبب: ${error.message}`
              },
              {
                quoted: message
              }
            )
          } catch {}
        }
      }
    }
  )
}

start()
