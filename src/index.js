/**
 * WAinAlbot - WhatsApp AI Bot para InAlbis Pages
 * Cloudflare Worker
 */

const SYSTEM_PROMPT = `Sos ClaudiA Albis, asistente virtual de InAlbis Pages, una agencia de diseño web moderna y rápida.

Sobre InAlbis Pages:
- Creamos páginas web profesionales para negocios que necesitan presencia en internet
- Somos rápidos, usamos las herramientas más actuales (Cloudflare, IA, diseño moderno)
- Ofrecemos soluciones modernas y accesibles para todo tipo de negocios
- Dominio: inalbis.pages.dev

Tu misión:
- Responder consultas sobre nuestros servicios de forma amable y profesional
- Captar el interés del cliente y guiarlo hacia agendar una reunión o pedir un presupuesto
- Preguntar qué tipo de negocio tiene el cliente y qué necesita
- Siempre terminar con una pregunta o llamado a la acción

Reglas:
- Respondé siempre en español (o inglés)
- Sé conciso (máximo 3 párrafos cortos)
- Nunca inventes precios exactos, decí que los presupuestos son personalizados
- Si preguntan por el precio, decí que depende del proyecto y mandales este link para solicitar una demo gratuita: https://inalbis.pages.dev/formulario
- Usá un tono cercano, moderno y profesional
- No te repitas constantemente o repitas palabras
- Nunca digas que sos una IA a menos que te lo pregunten directamente
- Al final de cada mensaje agregá siempre a la izquierda de la hora: "iA☁️"`;


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Verificación del webhook (GET)
    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // Recibir mensajes (POST)
    if (request.method === "POST") {
      try {
        const body = await request.json();
        const entry = body?.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];

        if (!message || message.type !== "text") {
          return new Response("OK", { status: 200 });
        }

        const from = message.from; // número del cliente
        const text = message.text.body;
        const phoneNumberId = value.metadata.phone_number_id;

        // Obtener historial de conversación desde KV
        let history = [];
        const stored = await env.CHAT_HISTORY.get(from);
        if (stored) {
          history = JSON.parse(stored);
        }

        // Agregar mensaje del usuario al historial
        history.push({ role: "user", content: text });

        // Mantener solo los últimos 10 mensajes (5 intercambios)
        if (history.length > 10) {
          history = history.slice(-10);
        }

        // Llamar al LLM (Groq)
        const aiResponse = await callGroq(history, env);

        // Agregar respuesta al historial
        history.push({ role: "assistant", content: aiResponse });

        // Guardar historial actualizado (expira en 24hs)
        await env.CHAT_HISTORY.put(from, JSON.stringify(history), {
          expirationTtl: 86400,
        });

        // Enviar respuesta por WhatsApp
        await sendWhatsAppMessage(from, aiResponse, phoneNumberId, env);

        return new Response("OK", { status: 200 });
      } catch (err) {
        console.error("Error:", err);
        return new Response("Error", { status: 500 });
      }
    }

    return new Response("Method not allowed", { status: 405 });
  },
};

async function callGroq(history, env) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 500,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...history
      ],
    }),
  });

  const data = await response.json();
  console.log("Groq response:", JSON.stringify(data));
  return data.choices?.[0]?.message?.content || "Disculpá, hubo un error. Intentá de nuevo.";
}

async function sendWhatsAppMessage(to, text, phoneNumberId, env) {
  await fetch(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    }
  );
}
