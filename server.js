const express = require("express");
const cors = require("cors");
const app = express();

const PORT = 4000;
const GOWA_URL = "http://localhost:3000";
const GOWA_USERNAME = "user1";
const GOWA_PASSWORD = "pass1";
app.use(cors());

app.use(express.json());

/**
 * ==========================================
 * GOWA WEBHOOK
 * ==========================================
 */
app.post("/webhook", (req, res) => {
    try {
        const { event, payload, session_id } = req.body;

        if (event !== "message") {
            return res.status(200).json({
                success: true,
                ignored: true,
            });
        }

        if (payload.is_from_me) {
            return res.status(200).json({
                success: true,
                ignored: true,
            });
        }

        const message = {
            session_id,
            message_id: payload.id,
            phone: payload.from.replace("@s.whatsapp.net", ""),
            name: payload.from_name || payload.sender_display_name,
            message: payload.body,
            chat_id: payload.chat_id,
            timestamp: payload.timestamp,
        };

        console.log("\n=================================");
        console.log("📩 INCOMING WHATSAPP");
        console.log("=================================");
        console.log("Phone   :", message.phone);
        console.log("Name    :", message.name);
        console.log("Message :", message.message);
        console.log("=================================\n");

        res.status(200).json({
            success: true,
            received: true,
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});


/**
 * ==========================================
 * SEND WHATSAPP MESSAGE
 * ==========================================
 */

const auth = Buffer.from(
    `${GOWA_USERNAME}:${GOWA_PASSWORD}`
).toString("base64");


app.post("/send-message", async (req, res) => {
    try {
        let { phone, message } = req.body;

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

        // Bersihkan nomor
        phone = phone
            .replace(/\D/g, "")
            .replace(/^0/, "62");

        // Format WhatsApp JID
        const phoneJid = `${phone}@s.whatsapp.net`;

        console.log("\n=================================");
        console.log("📤 SENDING WHATSAPP");
        console.log("=================================");
        console.log("To      :", phone);
        console.log("Message :", message);

        const response = await fetch(
            `${GOWA_URL}/send/message`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
            "Authorization": `Basic ${auth}`,
                },
                body: JSON.stringify({
                    phone: phoneJid,
                    message: message,
                }),
            }
        );

        const data = await response.json();

        console.log("GOWA response:", data);
        console.log("=================================\n");

        if (!response.ok) {
            return res.status(response.status).json({
                success: false,
                gowa: data,
            });
        }

        res.json({
            success: true,
            phone,
            message,
            gowa: data,
        });

    } catch (error) {
        console.error("Send message error:", error);

        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});


/**
 * ==========================================
 * HEALTH CHECK
 * ==========================================
 */
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "GOWA Webhook Server Running",
    });
});


app.listen(PORT, () => {
    console.log(`Webhook server running at http://localhost:${PORT}`);
});
