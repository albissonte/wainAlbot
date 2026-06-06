/**
 * WAinAlbot - WhatsApp + Web AI Bot para InAlbis Pages
 * Cloudflare Worker — src/index.js
 *
 * Variables de entorno (Settings → Variables y secretos):
 *   GROQ_API_KEY      → tu API key de Groq (ya la tenías)
 *   VERIFY_TOKEN      → el token que pusiste en Meta (ya lo tenías)
 *   WHATSAPP_TOKEN    → token de WhatsApp Business (ya lo tenías)
 *
 * KV Binding (Settings → Bindings):
 *   CHAT_HISTORY      → el mismo KV que ya tenías ✅
 */

const SYSTEM_PROMPT = `Sos el asistente virtual de InAlbis Pages, una agencia de diseño web moderna y rápida.

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
- Si el cliente menciona su nombre, email o teléfono, recordarlo y usarlo en la conversación
- Si ya conocés al cliente (viene del contexto), saludarlo por su nombre

Reglas:
- Respondé siempre en español
- Sé conciso (máximo 3 párrafos cortos)
- Nunca inventes precios exactos, decí que los presupuestos son personalizados
- Si preguntan por el precio, decí que depende del proyecto y ofrecé agendar una llamada gratuita
- Usá un tono cercano, moderno y profesional
- Nunca digas que sos una IA a menos que te lo pregunten directamente
- Al final de cada mensaje agregá siempre en una línea nueva: "☁️ _InAlbis Pages · IA_"`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Preflight CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── Chatbot web: POST /chat ───────────────────────────────
    if (url.pathname === "/chat" && request.method === "POST") {
      return handleWebChat(request, env);
    }

    // ── WhatsApp webhook: GET (verificación de Meta) ──────────
    if (request.method === "GET") {
      const mode      = url.searchParams.get("hub.mode");
      const token     = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // ── WhatsApp webhook: POST (mensajes entrantes) ───────────
    if (request.method === "POST") {
      return handleWhatsApp(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ─────────────────────────────────────────────────────────────
// HANDLER: Chatbot web
// Recibe: { sessionId: string, message: string }
// ─────────────────────────────────────────────────────────────
async function handleWebChat(request, env) {
  try {
    const { sessionId, message } = await request.json();

    if (!sessionId || !message) {
      return new Response(
        JSON.stringify({ error: "Faltan campos" }),
        { status: 400, headers: { "Content-Type": "application/json", ...CORS } }
      );
    }

    const kvKey = `web:${sessionId}`;
    const stored = await env.CHAT_HISTORY.get(kvKey);
    let history = stored ? JSON.parse(stored) : [];

    // Detectar y guardar datos del cliente
    const profile = await detectAndSaveProfile(kvKey, message, env);

    // Armar system prompt con perfil si existe
    const systemPrompt = buildSystemPrompt(profile);

    history.push({ role: "user", content: message });
    if (history.length > 10) history = history.slice(-10);

    const aiResponse = await callGroq(history, systemPrompt, env);

    history.push({ role: "assistant", content: aiResponse });
    await env.CHAT_HISTORY.put(kvKey, JSON.stringify(history), {
      expirationTtl: 86400,
    });

    return new Response(
      JSON.stringify({ reply: aiResponse }),
      { status: 200, headers: { "Content-Type": "application/json", ...CORS } }
    );

  } catch (err) {
    console.error("Web chat error:", err);
    return new Response(
      JSON.stringify({ error: "Error interno" }),
      { status: 500, headers: { "Content-Type": "application/json", ...CORS } }
    );
  }
}

// ─────────────────────────────────────────────────────────────
// HANDLER: WhatsApp
// ─────────────────────────────────────────────────────────────
async function handleWhatsApp(request, env) {
  try {
    const body    = await request.json();
    const entry   = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== "text") {
      return new Response("OK", { status: 200 });
    }

    const from          = message.from; // ej: "5491112345678"
    const text          = message.text.body;
    const phoneNumberId = value.metadata.phone_number_id;

    const kvKey = `wa:${from}`;
    const stored = await env.CHAT_HISTORY.get(kvKey);
    let history = stored ? JSON.parse(stored) : [];

    // Detectar y guardar perfil del cliente
    const profile = await detectAndSaveProfile(kvKey, text, env);
    // Agregar el teléfono de WhatsApp al perfil automáticamente
    if (!profile.phone) {
      profile.phone = from;
      await env.CHAT_HISTORY.put(
        `profile:${kvKey}`,
        JSON.stringify({ ...profile, phone: from }),
        { expirationTtl: 604800 }
      );
    }

    const systemPrompt = buildSystemPrompt(profile);

    history.push({ role: "user", content: text });
    if (history.length > 10) history = history.slice(-10);

    const aiResponse = await callGroq(history, systemPrompt, env);

    history.push({ role: "assistant", content: aiResponse });
    await env.CHAT_HISTORY.put(kvKey, JSON.stringify(history), {
      expirationTtl: 86400,
    });

    await sendWhatsAppMessage(from, aiResponse, phoneNumberId, env);

    return new Response("OK", { status: 200 });

  } catch (err) {
    console.error("WhatsApp error:", err);
    return new Response("Error", { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────
// Detecta nombre, email y teléfono en el mensaje y los guarda
// ─────────────────────────────────────────────────────────────
async function detectAndSaveProfile(kvKey, message, env) {
  const profileKey = `profile:${kvKey}`;
  const stored = await env.CHAT_HISTORY.get(profileKey);
  let profile = stored ? JSON.parse(stored) : {};
  let updated = false;

  // Email
  const emailMatch = message.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  if (emailMatch && !profile.email) {
    profile.email = emailMatch[0];
    updated = true;
  }

  // Teléfono
  const phoneMatch = message.match(/(?:\+?54|0)?(?:9)?(?:11|[2-9]\d{2,3})[\s\-]?\d{4}[\s\-]?\d{4}/);
  if (phoneMatch && !profile.phone) {
    profile.phone = phoneMatch[0].replace(/[\s\-]/g, "");
    updated = true;
  }

  // Nombre ("me llamo X", "soy X", "mi nombre es X")
  const nameMatch = message.match(
    /(?:me llamo|soy|mi nombre es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/i
  );
  if (nameMatch && !profile.name) {
    profile.name = nameMatch[1];
    updated = true;
  }

  if (updated) {
    await env.CHAT_HISTORY.put(profileKey, JSON.stringify(profile), {
      expirationTtl: 604800, // 7 días
    });
  }

  return profile;
}

// ─────────────────────────────────────────────────────────────
// Construye el system prompt con datos del cliente si los hay
// ─────────────────────────────────────────────────────────────
function buildSystemPrompt(profile) {
  let prompt = SYSTEM_PROMPT;
  if (profile.name || profile.email || profile.phone) {
    prompt += "\n\nDatos conocidos de este cliente:";
    if (profile.name)  prompt += `\n- Nombre: ${profile.name}`;
    if (profile.email) prompt += `\n- Email: ${profile.email}`;
    if (profile.phone) prompt += `\n- Teléfono: ${profile.phone}`;
    prompt += "\nUsá su nombre cuando sea natural en la conversación.";
  }
  return prompt;
}

// ─────────────────────────────────────────────────────────────
// Llama a Groq
// ─────────────────────────────────────────────────────────────
async function callGroq(history, systemPrompt, env) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama3-8b-8192",
      max_tokens: 500,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
      ],
    }),
  });

  const data = await response.json();
  console.log("Groq response:", JSON.stringify(data));
  return (
    data.choices?.[0]?.message?.content ||
    "Disculpá, hubo un error. Intentá de nuevo."
  );
}

// ─────────────────────────────────────────────────────────────
// Envía mensaje por WhatsApp Business API
// ─────────────────────────────────────────────────────────────
async function sendWhatsAppMessage(to, text, phoneNumberId, env) {
  await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
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
  });
}
