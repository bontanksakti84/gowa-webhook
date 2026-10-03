require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");

const app = express();

/**
 * ==========================================
 * CONFIG
 * ==========================================
 */

const PORT = process.env.PORT || 4000;

const GOWA_URL = process.env.GOWA_URL;
const GOWA_USERNAME = process.env.GOWA_USERNAME;
const GOWA_PASSWORD = process.env.GOWA_PASSWORD;

const GROQ_MODEL =
    process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

/**
 * AI AUTO REPLY
 *
 * false = AI tidak membalas pesan masuk
 * true  = AI aktif membalas pesan masuk
 */

const AI_AUTO_REPLY_ENABLED =
    String(
        process.env.AI_AUTO_REPLY_ENABLED || "false"
    ).toLowerCase() === "true";

/**
 * GROQ
 */

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

/**
 * ==========================================
 * OUTBOUND CONFIG
 * ==========================================
 *
 * Default:
 * - max 20 outbound / day
 * - delay 20-60 seconds
 * - cooldown after every 5 messages
 */

const OUTBOUND_DAILY_LIMIT =
    Number(
        process.env.OUTBOUND_DAILY_LIMIT || 20
    );

const OUTBOUND_MIN_DELAY =
    Number(
        process.env.OUTBOUND_MIN_DELAY || 20
    ) * 1000;

const OUTBOUND_MAX_DELAY =
    Number(
        process.env.OUTBOUND_MAX_DELAY || 60
    ) * 1000;

const OUTBOUND_COOLDOWN_EVERY =
    Number(
        process.env.OUTBOUND_COOLDOWN_EVERY || 5
    );

const OUTBOUND_COOLDOWN_MIN =
    Number(
        process.env.OUTBOUND_COOLDOWN_MIN || 120
    ) * 1000;

const OUTBOUND_COOLDOWN_MAX =
    Number(
        process.env.OUTBOUND_COOLDOWN_MAX || 300
    ) * 1000;

const MAX_RETRY =
    Number(
        process.env.OUTBOUND_MAX_RETRY || 2
    );

/**
 * ==========================================
 * FILE STORAGE
 * ==========================================
 */

const dataDir =
    path.join(__dirname, "data");

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, {
        recursive: true,
    });
}

const queuePath =
    path.join(
        dataDir,
        "outbound-queue.json"
    );

const blacklistPath =
    path.join(
        dataDir,
        "blacklist.json"
    );

const statsPath =
    path.join(
        dataDir,
        "outbound-stats.json"
    );

/**
 * ==========================================
 * MEMORY
 * ==========================================
 */

const conversationMemory =
    new Map();

let outboundQueue =
    loadJSON(
        queuePath,
        []
    );

let blacklist =
    loadJSON(
        blacklistPath,
        []
    );

let outboundStats =
    loadJSON(
        statsPath,
        {
            date: getToday(),
            sent: 0,
        }
    );

let queueWorkerRunning =
    false;

/**
 * ==========================================
 * AUTH
 * ==========================================
 */

const auth =
    Buffer.from(
        `${GOWA_USERNAME}:${GOWA_PASSWORD}`
    ).toString("base64");

/**
 * ==========================================
 * KNOWLEDGE BASE
 * ==========================================
 */

const knowledgePath =
    path.join(
        __dirname,
        "knowledge",
        "business.txt"
    );

let businessKnowledge = "";

try {
    businessKnowledge =
        fs.readFileSync(
            knowledgePath,
            "utf8"
        );
} catch (error) {
    console.error(
        "⚠️ Knowledge base tidak ditemukan:",
        knowledgePath
    );
}

/**
 * ==========================================
 * MIDDLEWARE
 * ==========================================
 */

app.use(cors());

app.use(
    express.json()
);

/**
 * ==========================================
 * UTILITY
 * ==========================================
 */

function loadJSON(
    file,
    fallback
) {
    try {
        if (
            !fs.existsSync(file)
        ) {
            return fallback;
        }

        return JSON.parse(
            fs.readFileSync(
                file,
                "utf8"
            )
        );
    } catch (error) {
        console.error(
            `Failed loading ${file}:`,
            error.message
        );

        return fallback;
    }
}

function saveJSON(
    file,
    data
) {
    try {
        fs.writeFileSync(
            file,
            JSON.stringify(
                data,
                null,
                2
            )
        );
    } catch (error) {
        console.error(
            `Failed saving ${file}:`,
            error.message
        );
    }
}

function getToday() {
    const now =
        new Date();

    return now
        .toISOString()
        .slice(0, 10);
}

function normalizePhone(
    phone
) {
    return String(
        phone || ""
    )
        .replace(
            /\D/g,
            ""
        )
        .replace(
            /^0/,
            "62"
        );
}

function isGroupMessage(
    payload
) {
    const candidates = [
        payload?.chat_id,
        payload?.from,
        payload?.chat?.id,
        payload?.remote_jid,
        payload?.sender?.chat_id,
    ];

    return candidates.some(
        value =>
            String(
                value || ""
            ).includes(
                "@g.us"
            )
    );
}

function randomNumber(
    min,
    max
) {
    return (
        Math.floor(
            Math.random() *
                (max - min + 1)
        ) + min
    );
}

function sleep(ms) {
    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}

/**
 * ==========================================
 * DAILY STATS
 * ==========================================
 */

function resetDailyStatsIfNeeded() {
    const today =
        getToday();

    if (
        outboundStats.date !==
        today
    ) {
        outboundStats = {
            date: today,
            sent: 0,
        };

        saveJSON(
            statsPath,
            outboundStats
        );

        console.log(
            "\n📅 Daily outbound counter reset"
        );
    }
}

function getRemainingDailyQuota() {
    resetDailyStatsIfNeeded();

    return Math.max(
        0,
        OUTBOUND_DAILY_LIMIT -
            outboundStats.sent
    );
}

/**
 * ==========================================
 * BLACKLIST
 * ==========================================
 */

function isBlacklisted(
    phone
) {
    phone =
        normalizePhone(
            phone
        );

    return blacklist.includes(
        phone
    );
}

function addToBlacklist(
    phone,
    reason
) {
    phone =
        normalizePhone(
            phone
        );

    if (!phone) {
        return;
    }

    if (
        !blacklist.includes(
            phone
        )
    ) {
        blacklist.push(
            phone
        );

        saveJSON(
            blacklistPath,
            blacklist
        );

        console.log(
            `🚫 Added to blacklist: ${phone}`
        );

        console.log(
            `Reason: ${reason}`
        );
    }

    cancelQueuedMessagesForPhone(
        phone
    );
}

function cancelQueuedMessagesForPhone(
    phone
) {
    phone =
        normalizePhone(
            phone
        );

    let cancelled = 0;

    outboundQueue =
        outboundQueue.filter(
            item => {
                if (
                    normalizePhone(
                        item.phone
                    ) === phone &&
                    item.status ===
                        "pending"
                ) {
                    cancelled++;

                    return false;
                }

                return true;
            }
        );

    if (
        cancelled > 0
    ) {
        saveJSON(
            queuePath,
            outboundQueue
        );

        console.log(
            `🛑 Cancelled ${cancelled} queued message(s) for ${phone}`
        );
    }
}

/**
 * ==========================================
 * OPT-OUT DETECTOR
 * ==========================================
 */

function normalizeText(
    text
) {
    return String(
        text || ""
    )
        .toLowerCase()
        .replace(
            /\s+/g,
            " "
        )
        .trim();
}

function detectOptOut(
    message
) {
    const text =
        normalizeText(
            message
        );

    if (!text) {
        return false;
    }

    const patterns = [
        /\bstop\b/i,
        /\bunsubscribe\b/i,
        /\bberhenti\b/i,
        /\bjangan chat\b/i,
        /\bjangan hubungi\b/i,
        /\bjangan kirim\b/i,
        /\btidak mau\b/i,
        /\btidak berminat\b/i,
        /\bga minat\b/i,
        /\bgak minat\b/i,
        /\bnggak minat\b/i,
        /\bhapus nomor\b/i,
    ];

    return patterns.some(
        pattern =>
            pattern.test(text)
    );
}

/**
 * ==========================================
 * CONVERSATION MEMORY
 * ==========================================
 */

function getConversation(
    phone
) {
    if (
        !conversationMemory.has(
            phone
        )
    ) {
        conversationMemory.set(
            phone,
            []
        );
    }

    return conversationMemory.get(
        phone
    );
}

function addMessage(
    phone,
    role,
    content
) {
    const conversation =
        getConversation(
            phone
        );

    conversation.push({
        role,
        content,
    });

    if (
        conversation.length >
        20
    ) {
        conversation.splice(
            0,
            conversation.length -
                20
        );
    }
}

/**
 * ==========================================
 * GROQ AI
 * ==========================================
 */

async function generateAIReply(
    phone,
    message
) {
    try {
        const conversation =
            getConversation(
                phone
            );

        const messages = [
            {
                role: "system",
                content: `
Kamu adalah AI Customer Service untuk akun WhatsApp ini.

TUJUAN:

Kamu hanya membantu menjawab pertanyaan yang berkaitan
dengan WhatsApp ini dan informasi bisnis yang tersedia.

BATASAN:

- Jangan menjadi chatbot general-purpose.
- Jangan menjawab topik di luar knowledge base.
- Jangan mengarang informasi.
- Jangan menebak harga, alamat, layanan, nama, atau kontak.
- Jika informasi tidak tersedia, katakan bahwa informasi tersebut
  belum tersedia.
- Jika pertanyaan di luar cakupan, jawab:

"Maaf Kak, saya hanya dapat membantu informasi terkait
WhatsApp dan layanan kami. 😊"

- Gunakan bahasa Indonesia.
- Jawab singkat dan natural.
- Jangan mengaku sebagai manusia.

KNOWLEDGE BASE:
----------------
${businessKnowledge}
----------------

Gunakan knowledge base di atas sebagai sumber informasi.
                `,
            },

            ...conversation,
        ];

        console.log(
            "\n🧠 Conversation:"
        );

        console.log(
            JSON.stringify(
                conversation,
                null,
                2
            )
        );

        const completion =
            await groq.chat.completions.create(
                {
                    model:
                        GROQ_MODEL,

                    messages,

                    temperature:
                        0.7,

                    max_tokens:
                        500,
                }
            );

        const reply =
            completion
                .choices?.[0]
                ?.message
                ?.content;

        if (!reply) {
            throw new Error(
                "Groq tidak mengembalikan response"
            );
        }

        return reply;

    } catch (error) {
        console.error(
            "Groq error:",
            error.message
        );

        throw error;
    }
}

/**
 * ==========================================
 * GOWA SEND MESSAGE
 * ==========================================
 */

async function sendWhatsApp(
    phone,
    message
) {
    phone =
        normalizePhone(
            phone
        );

    const phoneJid =
        `${phone}@s.whatsapp.net`;

    console.log(
        "\n📤 SENDING WHATSAPP"
    );

    console.log(
        "To:",
        phone
    );

    console.log(
        "Message:",
        message
    );

    const response =
        await fetch(
            `${GOWA_URL}/send/message`,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json",

                    "Authorization":
                        `Basic ${auth}`,
                },

                body:
                    JSON.stringify({
                        phone:
                            phoneJid,

                        message:
                            message,
                    }),
            }
        );

    let data;

    try {
        data =
            await response.json();
    } catch {
        data = {
            raw:
                await response.text(),
        };
    }

    console.log(
        "GOWA response:",
        data
    );

    if (
        !response.ok
    ) {
        throw new Error(
            `GOWA error: ${JSON.stringify(data)}`
        );
    }

    return data;
}

/**
 * ==========================================
 * OUTBOUND QUEUE
 * ==========================================
 */

function queueOutboundMessage(
    phone,
    message
) {
    phone =
        normalizePhone(
            phone
        );

    if (!phone) {
        throw new Error(
            "Invalid phone number"
        );
    }

    if (
        isBlacklisted(phone)
    ) {
        throw new Error(
            "Phone is blacklisted"
        );
    }

    if (
        !message ||
        !message.trim()
    ) {
        throw new Error(
            "Message is required"
        );
    }

    const duplicate =
        outboundQueue.find(
            item =>
                normalizePhone(
                    item.phone
                ) === phone &&
                item.status ===
                    "pending"
        );

    if (duplicate) {
        throw new Error(
            "Phone already has a pending outbound message"
        );
    }

    const item = {
        id:
            `${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 8)}`,

        phone,

        message:
            message.trim(),

        status:
            "pending",

        retryCount:
            0,

        createdAt:
            new Date().toISOString(),

        sentAt:
            null,

        error:
            null,
    };

    outboundQueue.push(
        item
    );

    saveJSON(
        queuePath,
        outboundQueue
    );

    console.log(
        "\n📥 OUTBOUND QUEUED"
    );

    console.log(
        "ID:",
        item.id
    );

    console.log(
        "Phone:",
        phone
    );

    return item;
}

/**
 * ==========================================
 * GET NEXT QUEUE ITEM
 * ==========================================
 */

function getNextQueueItem() {
    return outboundQueue.find(
        item =>
            item.status ===
            "pending"
    );
}

/**
 * ==========================================
 * QUEUE ITEM
 * ==========================================
 */

function markQueueItem(
    item,
    status,
    error = null
) {
    item.status =
        status;

    item.error =
        error;

    saveJSON(
        queuePath,
        outboundQueue
    );
}

/**
 * ==========================================
 * OUTBOUND WORKER
 * ==========================================
 */

async function processOutboundQueue() {
    if (
        queueWorkerRunning
    ) {
        return;
    }

    queueWorkerRunning =
        true;

    try {
        while (true) {

            resetDailyStatsIfNeeded();

            /**
             * Daily limit reached
             */

            if (
                outboundStats.sent >=
                OUTBOUND_DAILY_LIMIT
            ) {
                console.log(
                    "\n⛔ Daily outbound limit reached:",
                    outboundStats.sent
                );

                break;
            }

            const item =
                getNextQueueItem();

            if (!item) {
                break;
            }

            const phone =
                normalizePhone(
                    item.phone
                );

            /**
             * Blacklist check
             */

            if (
                isBlacklisted(phone)
            ) {
                console.log(
                    `🚫 Skip blacklisted ${phone}`
                );

                markQueueItem(
                    item,
                    "cancelled",
                    "Phone is blacklisted"
                );

                continue;
            }

            /**
             * Mark processing
             */

            item.status =
                "processing";

            saveJSON(
                queuePath,
                outboundQueue
            );

            try {

                console.log(
                    "\n================================="
                );

                console.log(
                    "🚀 OUTBOUND QUEUE"
                );

                console.log(
                    "================================="
                );

                console.log(
                    "Phone:",
                    phone
                );

                console.log(
                    "Daily:",
                    `${outboundStats.sent}/${OUTBOUND_DAILY_LIMIT}`
                );

                await sendWhatsApp(
                    phone,
                    item.message
                );

                /**
                 * Success
                 */

                item.status =
                    "sent";

                item.sentAt =
                    new Date().toISOString();

                item.error =
                    null;

                outboundStats.sent++;

                saveJSON(
                    statsPath,
                    outboundStats
                );

                saveJSON(
                    queuePath,
                    outboundQueue
                );

                console.log(
                    `✅ OUTBOUND SENT ${phone}`
                );

                /**
                 * Cooldown
                 */

                if (
                    outboundStats.sent %
                        OUTBOUND_COOLDOWN_EVERY ===
                    0
                ) {

                    const cooldown =
                        randomNumber(
                            OUTBOUND_COOLDOWN_MIN,
                            OUTBOUND_COOLDOWN_MAX
                        );

                    console.log(
                        `\n☕ Cooldown ${Math.round(
                            cooldown / 1000
                        )} seconds`
                    );

                    await sleep(
                        cooldown
                    );

                } else {

                    const delay =
                        randomNumber(
                            OUTBOUND_MIN_DELAY,
                            OUTBOUND_MAX_DELAY
                        );

                    console.log(
                        `⏳ Next outbound in ${Math.round(
                            delay / 1000
                        )} seconds`
                    );

                    await sleep(
                        delay
                    );
                }

            } catch (error) {

                console.error(
                    `❌ Failed sending ${phone}:`,
                    error.message
                );

                item.retryCount++;

                if (
                    item.retryCount <=
                    MAX_RETRY
                ) {

                    item.status =
                        "pending";

                    item.error =
                        error.message;

                    saveJSON(
                        queuePath,
                        outboundQueue
                    );

                    const retryDelay =
                        randomNumber(
                            30,
                            90
                        ) * 1000;

                    console.log(
                        `🔄 Retry ${item.retryCount}/${MAX_RETRY} in ${Math.round(
                            retryDelay / 1000
                        )} seconds`
                    );

                    await sleep(
                        retryDelay
                    );

                } else {

                    item.status =
                        "failed";

                    item.error =
                        error.message;

                    saveJSON(
                        queuePath,
                        outboundQueue
                    );

                    console.log(
                        `❌ Permanently failed: ${phone}`
                    );
                }
            }
        }

    } finally {

        queueWorkerRunning =
            false;
    }
}

/**
 * ==========================================
 * WEBHOOK
 * ==========================================
 */

app.post(
    "/webhook",
    async (req, res) => {

        try {

            const {
                event,
                payload,
                session_id,
            } = req.body;

            /**
             * Ignore non-message events
             */

            if (
                event !== "message"
            ) {
                return res
                    .status(200)
                    .json({
                        success: true,
                        ignored: true,
                        reason:
                            "not a message event",
                    });
            }

            /**
             * Ignore invalid payload
             */

            if (!payload) {
                return res
                    .status(200)
                    .json({
                        success: true,
                        ignored: true,
                        reason:
                            "payload missing",
                    });
            }

            /**
             * Ignore our own messages
             */

            if (
                payload.is_from_me
            ) {
                return res
                    .status(200)
                    .json({
                        success: true,
                        ignored: true,
                        reason:
                            "message from me",
                    });
            }

            /**
             * Ignore group messages
             */

            if (
                isGroupMessage(
                    payload
                )
            ) {

                console.log(
                    "\n👥 GROUP MESSAGE DETECTED"
                );

                console.log(
                    "Chat ID:",
                    payload.chat_id
                );

                console.log(
                    "From:",
                    payload.from
                );

                console.log(
                    "⏭️ AI reply SKIPPED"
                );

                return res
                    .status(200)
                    .json({
                        success: true,
                        ignored: true,
                        reason:
                            "group message",
                    });
            }

            /**
             * Extract message
             */

            const phone =
                normalizePhone(
                    payload.from
                );

            const name =
                payload.from_name ||
                payload.sender_display_name ||
                "Customer";

            const message =
                payload.body || "";

            const chatId =
                payload.chat_id;

            const messageId =
                payload.id;

            const timestamp =
                payload.timestamp;

            console.log(
                "\n================================="
            );

            console.log(
                "📩 INCOMING WHATSAPP"
            );

            console.log(
                "================================="
            );

            console.log(
                "Phone   :",
                phone
            );

            console.log(
                "Name    :",
                name
            );

            console.log(
                "Message :",
                message
            );

            console.log(
                "Chat ID :",
                chatId
            );

            console.log(
                "Message ID:",
                messageId
            );

            console.log(
                "Timestamp:",
                timestamp
            );

            console.log(
                "AI Auto Reply:",
                AI_AUTO_REPLY_ENABLED
                    ? "ENABLED"
                    : "DISABLED"
            );

            console.log(
                "=================================\n"
            );

            /**
             * ACK GOWA immediately
             */

            res
                .status(200)
                .json({
                    success: true,
                    received: true,
                });

            /**
             * Ignore empty message
             */

            if (
                !message.trim()
            ) {
                return;
            }

            /**
             * ======================================
             * AI AUTO REPLY OFF
             * ======================================
             *
             * Jika false:
             * - tidak generate Groq
             * - tidak send WhatsApp
             * - tidak menjalankan conversation memory
             */

            if (
                !AI_AUTO_REPLY_ENABLED
            ) {

                console.log(
                    "\n⏸️ AI AUTO REPLY DISABLED"
                );

                console.log(
                    "Message received but no AI response will be sent."
                );

                return;
            }

            /**
             * ======================================
             * AI AUTO REPLY ENABLED
             * ======================================
             */

            /**
             * Cancel pending outbound
             */

            cancelQueuedMessagesForPhone(
                phone
            );

            /**
             * OPT-OUT
             */

            if (
                detectOptOut(
                    message
                )
            ) {

                console.log(
                    `🚫 OPT-OUT detected from ${phone}`
                );

                addToBlacklist(
                    phone,
                    "Customer requested no further messages"
                );

                return;
            }

            /**
             * NORMAL HUMAN MESSAGE
             */

            addMessage(
                phone,
                "user",
                message
            );

            /**
             * AI PROCESSING
             */

            const aiReply =
                await generateAIReply(
                    phone,
                    message
                );

            addMessage(
                phone,
                "assistant",
                aiReply
            );

            /**
             * Send AI response
             */

            await sendWhatsApp(
                phone,
                aiReply
            );

            console.log(
                "\n✅ AI REPLY SENT"
            );

        } catch (error) {

            console.error(
                "\n❌ WEBHOOK ERROR"
            );

            console.error(
                error
            );
        }
    }
);

/**
 * ==========================================
 * MANUAL / OUTBOUND QUEUE
 * ==========================================
 */

app.post(
    "/send-message",
    async (req, res) => {

        try {

            let {
                phone,
                message,
            } = req.body;

            if (!phone) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            "phone is required",
                    });
            }

            if (!message) {
                return res
                    .status(400)
                    .json({
                        success: false,
                        error:
                            "message is required",
                    });
            }

            phone =
                normalizePhone(
                    phone
                );

            /**
             * Blacklist
             */

            if (
                isBlacklisted(phone)
            ) {
                return res
                    .status(403)
                    .json({
                        success: false,
                        error:
                            "phone is blacklisted",
                    });
            }

            /**
             * Daily quota
             */

            const remaining =
                getRemainingDailyQuota();

            if (
                remaining <= 0
            ) {
                return res
                    .status(429)
                    .json({
                        success: false,
                        error:
                            "daily outbound limit reached",

                        limit:
                            OUTBOUND_DAILY_LIMIT,
                    });
            }

            /**
             * Queue
             */

            const item =
                queueOutboundMessage(
                    phone,
                    message
                );

            /**
             * Start worker
             */

            processOutboundQueue()
                .catch(
                    error => {
                        console.error(
                            "Queue worker error:",
                            error
                        );
                    }
                );

            res.json({
                success: true,

                queued: true,

                queue_id:
                    item.id,

                phone:
                    phone,

                message:
                    message,

                remaining_daily_quota:
                    remaining - 1,
            });

        } catch (error) {

            console.error(
                "Queue message error:",
                error
            );

            res
                .status(500)
                .json({
                    success: false,
                    error:
                        error.message,
                });
        }
    }
);

/**
 * ==========================================
 * QUEUE STATUS
 * ==========================================
 */

app.get(
    "/queue",
    (req, res) => {

        resetDailyStatsIfNeeded();

        const pending =
            outboundQueue.filter(
                item =>
                    item.status ===
                    "pending"
            );

        const processing =
            outboundQueue.filter(
                item =>
                    item.status ===
                    "processing"
            );

        const sent =
            outboundQueue.filter(
                item =>
                    item.status ===
                    "sent"
            );

        const failed =
            outboundQueue.filter(
                item =>
                    item.status ===
                    "failed"
            );

        res.json({

            success: true,

            ai_auto_reply:
                AI_AUTO_REPLY_ENABLED,

            daily: {

                limit:
                    OUTBOUND_DAILY_LIMIT,

                sent:
                    outboundStats.sent,

                remaining:
                    getRemainingDailyQuota(),
            },

            queue: {

                pending:
                    pending.length,

                processing:
                    processing.length,

                sent:
                    sent.length,

                failed:
                    failed.length,
            },

            worker:
                queueWorkerRunning,

            items:
                outboundQueue,
        });
    }
);

/**
 * ==========================================
 * BLACKLIST
 * ==========================================
 */

app.get(
    "/blacklist",
    (req, res) => {

        res.json({

            success: true,

            count:
                blacklist.length,

            blacklist,
        });
    }
);

/**
 * ==========================================
 * REMOVE BLACKLIST
 * ==========================================
 */

app.delete(
    "/blacklist/:phone",
    (req, res) => {

        const phone =
            normalizePhone(
                req.params.phone
            );

        blacklist =
            blacklist.filter(
                item =>
                    item !== phone
            );

        saveJSON(
            blacklistPath,
            blacklist
        );

        res.json({

            success: true,

            phone,

            removed: true,
        });
    }
);

/**
 * ==========================================
 * HEALTH CHECK
 * ==========================================
 */

app.get(
    "/",
    (req, res) => {

        resetDailyStatsIfNeeded();

        res.json({

            success: true,

            message:
                "GOWA AI Chatbot Running",

            model:
                GROQ_MODEL,

            ai_auto_reply:
                AI_AUTO_REPLY_ENABLED,

            outbound: {

                daily_limit:
                    OUTBOUND_DAILY_LIMIT,

                sent_today:
                    outboundStats.sent,

                remaining:
                    getRemainingDailyQuota(),

                queue:
                    outboundQueue.filter(
                        item =>
                            item.status ===
                            "pending"
                    ).length,
            },
        });
    }
);

/**
 * ==========================================
 * START SERVER
 * ==========================================
 */

app.listen(
    PORT,
    () => {

        console.log(
            "\n================================="
        );

        console.log(
            "🤖 GOWA AI CHATBOT"
        );

        console.log(
            "================================="
        );

        console.log(
            `Server      : http://localhost:${PORT}`
        );

        console.log(
            `GOWA        : ${GOWA_URL}`
        );

        console.log(
            `Groq model  : ${GROQ_MODEL}`
        );

        console.log(
            `AI Auto Reply: ${
                AI_AUTO_REPLY_ENABLED
                    ? "ENABLED"
                    : "DISABLED"
            }`
        );

        console.log(
            `Daily limit : ${OUTBOUND_DAILY_LIMIT}`
        );

        console.log(
            `Delay       : ${
                OUTBOUND_MIN_DELAY / 1000
            }-${
                OUTBOUND_MAX_DELAY / 1000
            } seconds`
        );

        console.log(
            `Queue       : ${outboundQueue.length} item(s)`
        );

        console.log(
            "=================================\n"
        );

        /**
         * Resume queue after restart
         */

        setTimeout(
            () => {

                processOutboundQueue()
                    .catch(
                        error => {
                            console.error(
                                "Initial queue worker error:",
                                error
                            );
                        }
                    );

            },
            3000
        );
    }
);