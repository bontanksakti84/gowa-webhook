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
 *
 * Ini adalah rate limiting untuk mencegah
 * burst sending dan menjaga kualitas outbound.
 */

const OUTBOUND_DAILY_LIMIT =
    Number(process.env.OUTBOUND_DAILY_LIMIT || 20);

const OUTBOUND_MIN_DELAY =
    Number(process.env.OUTBOUND_MIN_DELAY || 20) * 1000;

const OUTBOUND_MAX_DELAY =
    Number(process.env.OUTBOUND_MAX_DELAY || 60) * 1000;

const OUTBOUND_COOLDOWN_EVERY =
    Number(process.env.OUTBOUND_COOLDOWN_EVERY || 5);

const OUTBOUND_COOLDOWN_MIN =
    Number(process.env.OUTBOUND_COOLDOWN_MIN || 120) * 1000;

const OUTBOUND_COOLDOWN_MAX =
    Number(process.env.OUTBOUND_COOLDOWN_MAX || 300) * 1000;

const MAX_RETRY =
    Number(process.env.OUTBOUND_MAX_RETRY || 2);


/**
 * ==========================================
 * FILE STORAGE
 * ==========================================
 */

const dataDir = path.join(__dirname, "data");

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, {
        recursive: true,
    });
}

const queuePath =
    path.join(dataDir, "outbound-queue.json");

const blacklistPath =
    path.join(dataDir, "blacklist.json");

const statsPath =
    path.join(dataDir, "outbound-stats.json");


/**
 * ==========================================
 * MEMORY
 * ==========================================
 */

const conversationMemory = new Map();

let outboundQueue = loadJSON(
    queuePath,
    []
);

let blacklist = loadJSON(
    blacklistPath,
    []
);

let outboundStats = loadJSON(
    statsPath,
    {
        date: getToday(),
        sent: 0,
    }
);

let queueWorkerRunning = false;


/**
 * ==========================================
 * AUTH
 * ==========================================
 */

const auth = Buffer.from(
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

const businessKnowledge =
    fs.readFileSync(
        knowledgePath,
        "utf8"
    );


/**
 * ==========================================
 * MIDDLEWARE
 * ==========================================
 */

app.use(cors());

app.use(express.json());


/**
 * ==========================================
 * UTILITY
 * ==========================================
 */

function loadJSON(file, fallback) {
    try {
        if (!fs.existsSync(file)) {
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


function saveJSON(file, data) {
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
    const now = new Date();

    return now
        .toISOString()
        .slice(0, 10);
}


function normalizePhone(phone) {
    return String(phone || "")
        .replace(/\D/g, "")
        .replace(/^0/, "62");
}

function isGroupMessage(payload) {
    const candidates = [
        payload?.chat_id,
        payload?.from,
        payload?.chat?.id,
        payload?.remote_jid,
        payload?.sender?.chat_id,
    ];

    return candidates.some(value => {
        return String(value || "").includes("@g.us");
    });
}

function randomNumber(min, max) {
    return Math.floor(
        Math.random() *
            (max - min + 1)
    ) + min;
}


function sleep(ms) {
    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}


/**
 * ==========================================
 * DAILY STATS
 * ==========================================
 */

function resetDailyStatsIfNeeded() {

    const today = getToday();

    if (outboundStats.date !== today) {

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
 * BLACKLIST / SUPPRESSION
 * ==========================================
 */

function isBlacklisted(phone) {

    phone = normalizePhone(phone);

    return blacklist.includes(phone);
}


function addToBlacklist(phone, reason) {

    phone = normalizePhone(phone);

    if (!phone) {
        return;
    }

    if (!blacklist.includes(phone)) {

        blacklist.push(phone);

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

    cancelQueuedMessagesForPhone(phone);
}


function cancelQueuedMessagesForPhone(phone) {

    phone = normalizePhone(phone);

    let cancelled = 0;

    outboundQueue =
        outboundQueue.filter(item => {

            if (
                normalizePhone(item.phone) === phone &&
                item.status === "pending"
            ) {
                cancelled++;
                return false;
            }

            return true;
        });

    if (cancelled > 0) {

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

function detectOptOut(message) {

    const text =
        normalizeText(message);

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
        pattern => pattern.test(text)
    );
}


/**
 * ==========================================
 * AUTO REPLY DETECTOR
 * ==========================================
 */

function normalizeText(text) {

    return String(text || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}


function detectAutoReply(message) {

    const text =
        normalizeText(message);

    if (!text) {

        return {
            isAutoReply: false,
            score: 0,
            reasons: [],
        };
    }

    const rules = [

        {
            pattern:
                /terima kasih (telah|sudah|atas) menghubungi/,
            score: 2,
            reason:
                "greeting auto-reply",
        },

        {
            pattern:
                /kami akan (segera )?(membalas|merespons)/,
            score: 3,
            reason:
                "promise to reply",
        },

        {
            pattern:
                /akan membalas pesan/,
            score: 3,
            reason:
                "promise to reply",
        },

        {
            pattern:
                /sambil menunggu/,
            score: 2,
            reason:
                "waiting message",
        },

        {
            pattern:
                /lihat\s*\*?2?\s*\*?\s*(katalog|catalog)/,
            score: 2,
            reason:
                "catalog CTA",
        },

        {
            pattern:
                /katalog kami/,
            score: 2,
            reason:
                "catalog CTA",
        },

        {
            pattern:
                /https?:\/\/wa\.me\/c\//,
            score: 3,
            reason:
                "WhatsApp catalog link",
        },

        {
            pattern:
                /wa\.me\/c\//,
            score: 3,
            reason:
                "WhatsApp catalog link",
        },

        {
            pattern:
                /terima kasih.{0,50}😊|😊.{0,50}terima kasih/,
            score: 1,
            reason:
                "closing message",
        },

    ];

    let score = 0;

    const reasons = [];

    for (const rule of rules) {

        if (rule.pattern.test(text)) {

            score += rule.score;

            reasons.push(
                rule.reason
            );
        }
    }

    return {

        isAutoReply:
            score >= 4,

        score,

        reasons,

    };
}


/**
 * ==========================================
 * CONVERSATION MEMORY
 * ==========================================
 */

function getConversation(phone) {

    if (
        !conversationMemory.has(phone)
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
        getConversation(phone);

    conversation.push({

        role,

        content,

    });

    if (
        conversation.length > 20
    ) {

        conversation.splice(
            0,
            conversation.length - 20
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
            getConversation(phone);

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
            await groq.chat.completions.create({

                model:
                    GROQ_MODEL,

                messages,

                temperature: 0.7,

                max_tokens: 500,

            });


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
        normalizePhone(phone);

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

                body: JSON.stringify({

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


    if (!response.ok) {

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
        normalizePhone(phone);

    if (!phone) {

        throw new Error(
            "Invalid phone number"
        );
    }


    if (isBlacklisted(phone)) {

        throw new Error(
            "Phone is blacklisted"
        );
    }


    if (!message || !message.trim()) {

        throw new Error(
            "Message is required"
        );
    }


    /**
     * Prevent duplicate pending
     * message for same phone.
     */

    const duplicate =
        outboundQueue.find(
            item =>
                normalizePhone(
                    item.phone
                ) === phone &&
                item.status === "pending"
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


    outboundQueue.push(item);

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
            item.status === "pending"
    );
}


/**
 * ==========================================
 * REMOVE / CANCEL QUEUE ITEM
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

    if (queueWorkerRunning) {
        return;
    }

    queueWorkerRunning = true;


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
             * Check blacklist
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
                 * Cooldown after every
                 * N successful messages.
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

                    /**
                     * Normal delay
                     */

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


                    /**
                     * Wait before retry
                     */

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

        queueWorkerRunning = false;
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
                if (isGroupMessage(payload)) {
                    console.log("\n👥 GROUP MESSAGE DETECTED");
                    console.log("Chat ID:", payload.chat_id);
                    console.log("From:", payload.from);
                    console.log("⏭️ AI reply SKIPPED");

                    return res
                        .status(200)
                        .json({
                            success: true,
                            ignored: true,
                            reason: "group message",
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
                "=================================\n"
            );


            /**
             * IMPORTANT:
             * ACK GOWA immediately.
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

            if (!message.trim()) {
                return;
            }


            /**
             * ======================================
             * IMPORTANT:
             * Any real incoming message means
             * this contact has engaged.
             *
             * Cancel pending outbound sequence.
             * ======================================
             */

            cancelQueuedMessagesForPhone(
                phone
            );


            /**
             * ======================================
             * OPT-OUT
             * ======================================
             */

            if (
                detectOptOut(message)
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
             * ======================================
             * AUTO REPLY
             * ======================================
             */

            /*             
            const autoReply =
                detectAutoReply(
                    message
                );


            if (
                autoReply.isAutoReply
            ) {

                console.log(
                    "\n🤖 AUTO-REPLY DETECTED"
                );

                console.log(
                    "Score:",
                    autoReply.score
                );

                console.log(
                    "Reasons:",
                    autoReply.reasons
                );

                console.log(
                    "⏸️ AI reply SKIPPED"
                );

               

                return;
            } 
            */


            /**
             * ======================================
             * NORMAL HUMAN MESSAGE
             * ======================================
             */

            addMessage(
                phone,
                "user",
                message
            );


            /**
             * ======================================
             * AI PROCESSING
             * ======================================
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
             * ======================================
             * SEND AI RESPONSE
             *
             * AI response is NOT put into
             * outbound marketing queue.
             *
             * This is an immediate conversational
             * response.
             * ======================================
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
 *
 * IMPORTANT:
 *
 * Sebelumnya endpoint ini langsung
 * mengirim ke GOWA.
 *
 * Sekarang hanya memasukkan ke queue.
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
                normalizePhone(phone);


            /**
             * Check blacklist
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
             * Check daily quota
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
                .catch(error => {

                    console.error(
                        "Queue worker error:",
                        error
                    );

                });


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
 * BLACKLIST ENDPOINT
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
 * REMOVE FROM BLACKLIST
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
            `🤖 GOWA AI Chatbot running at http://localhost:${PORT}`
        );

        console.log(
            `GOWA: ${GOWA_URL}`
        );

        console.log(
            `Groq model: ${GROQ_MODEL}`
        );

        console.log(
            `Outbound daily limit: ${OUTBOUND_DAILY_LIMIT}`
        );

        console.log(
            `Outbound delay: ${OUTBOUND_MIN_DELAY / 1000}-${OUTBOUND_MAX_DELAY / 1000} seconds`
        );

        console.log(
            `Outbound queue: ${outboundQueue.length} item(s)`
        );

        /**
         * Resume queue after server restart.
         */
        setTimeout(() => {

            processOutboundQueue()
                .catch(error => {

                    console.error(
                        "Initial queue worker error:",
                        error
                    );

                });

        }, 3000);

    }
);