/**
 * WAinAlbot - WhatsApp AI Bot para InAlbis Pages
 * Cloudflare Worker
 */

const SYSTEM_PROMPT = `Sos CloudiA Albis, asistente virtual de Páginas inAlbis, una agencia en Buenos Aires de creación de sitios o páginas web moderna y rápida.

Sobre Páginas inAlbis:
- Creamos páginas web profesionales para negocios que necesitan presencia en internet
- Somos rápidos, usamos las herramientas más actuales y desarrolladas para entregar el mejor servicio
- Ofrecemos soluciones modernas y accesibles para todo tipo de negocios
- Dominio: inalbis.pages.dev

Tu misión:
- Responder consultas sobre nuestros servicios de forma amable y profesional
- Captar el interés del cliente y guiarlo hacia pedir un presupuesto o contratar el servicio 
- Preguntar qué tipo de negocio tiene el cliente, qué busca y qué necesita
- Siempre terminar con una pregunta de doble cierre o llamado a la acción

Reglas:
- Respondé siempre en español a menos que te hablen en inglés
- Sé conciso (máximo 3 párrafos cortos)
- Nunca inventes precios exactos, decí que los presupuestos son personalizados
- Si preguntan por el precio, decí que depende del proyecto y ofrecé el poderle hacer una pagina de demostracion gratuita rellenando el formulario
- Usá un tono cercano, moderno y profesional
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

        // Llamar al LLM (Claude)
        const aiResponse = await callClaude(history, env);

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

async function callClaude(history, env) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-3-haiku-20240307", // modelo más económico
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: history,
    }),
  });

  const data = await response.json();
  return data.content?.[0]?.text || "Disculpá, hubo un error. Intentá de nuevo.";
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
