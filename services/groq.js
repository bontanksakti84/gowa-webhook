const Groq = require("groq-sdk");

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
});

async function generateReply(message) {

    const completion = await groq.chat.completions.create({
        model: process.env.GROQ_MODEL,

        messages: [
            {
                role: "system",
                content: `
Kamu adalah customer service yang ramah.

Gunakan bahasa Indonesia yang natural.
Jawab singkat dan jelas.
Jangan mengarang informasi.
Jika informasi belum tersedia, tanyakan kepada customer.
                `,
            },
            {
                role: "user",
                content: message,
            },
        ],

        temperature: 0.7,
        max_tokens: 500,
    });

    return completion.choices[0].message.content;
}

module.exports = {
    generateReply,
};