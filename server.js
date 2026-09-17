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
const conversationMemory = new Map();


const auth = Buffer.from(
    `${GOWA_USERNAME}:${GOWA_PASSWORD}`
).toString("base64");

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

                model: GROQ_MODEL,

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

async function sendWhatsApp(phone, message) {

    phone = phone
        .replace(/\D/g, "")
        .replace(/^0/, "62");

    const phoneJid =
        `${phone}@s.whatsapp.net`;

    console.log("\n📤 SENDING WHATSAPP");
    console.log("To:", phone);
    console.log("Message:", message);

    const response = await fetch(
        `${GOWA_URL}/send/message`,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json",
                "Authorization":
                    `Basic ${auth}`,
            },

            body: JSON.stringify({
                phone: phoneJid,
                message: message,
            }),
        }
    );

    const data = await response.json();

    console.log("GOWA response:", data);

    if (!response.ok) {

        throw new Error(
            `GOWA error: ${JSON.stringify(data)}`
        );
    }

    return data;
}


/**
 * ==========================================
 * GOWA WEBHOOK
 * ==========================================
 */

app.post("/webhook", async (req, res) => {

    try {

        const {
            event,
            payload,
            session_id,
        } = req.body;


        /**
         * Ignore non-message events
         */

        if (event !== "message") {

            return res.status(200).json({
                success: true,
                ignored: true,
                reason: "not a message event",
            });
        }


        /**
         * Ignore invalid payload
         */

        if (!payload) {

            return res.status(200).json({
                success: true,
                ignored: true,
                reason: "payload missing",
            });
        }


        /**
         * Ignore our own messages
         */

        if (payload.is_from_me) {

            return res.status(200).json({
                success: true,
                ignored: true,
                reason: "message from me",
            });
        }


        /**
         * Extract message
         */

        const phone =
            payload.from
                .replace("@s.whatsapp.net", "");

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
            "=================================\n"
        );


        /**
         * IMPORTANT:
         * Respond immediately to GOWA.
         *
         * AI processing happens after
         * webhook acknowledgement.
         */

        res.status(200).json({
            success: true,
            received: true,
        });


        /**
         * Ignore empty message
         */

        if (!message.trim()) {
            return;
        }


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
});


/**
 * ==========================================
 * MANUAL SEND MESSAGE
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

                return res.status(400).json({
                    success: false,
                    error: "phone is required",
                });
            }


            if (!message) {

                return res.status(400).json({
                    success: false,
                    error: "message is required",
                });
            }


            const data =
                await sendWhatsApp(
                    phone,
                    message
                );


            res.json({

                success: true,

                phone,

                message,

                gowa: data,

            });

        } catch (error) {

            console.error(
                "Send message error:",
                error
            );

            res.status(500).json({

                success: false,

                error: error.message,

            });
        }
    }
);


/**
 * ==========================================
 * HEALTH CHECK
 * ==========================================
 */

app.get("/", (req, res) => {

    res.json({

        success: true,

        message:
            "GOWA AI Chatbot Running",

        model:
            GROQ_MODEL,

    });
});

function getConversation(phone) {

    if (!conversationMemory.has(phone)) {

        conversationMemory.set(phone, []);

    }

    return conversationMemory.get(phone);
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

    // Simpan maksimal 20 message
    if (conversation.length > 20) {

        conversation.splice(
            0,
            conversation.length - 20
        );

    }
}


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

    }
);