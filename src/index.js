/**
 * WAinAlbot - WhatsApp + Web AI Bot para InAlbis Pages
 * Cloudflare Worker — src/index.js
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
- Si ya conocés al cliente por su nombre, usarlo naturalmente en la conversación

Cómo recopilar datos del cliente:
- En los primeros 2 mensajes, enfocate solo en entender su negocio y necesidad
- Cuando el cliente muestre interés real (pide precio, quiere una reunión, pregunta por tiempos), decile de forma natural: "Para ayudarte mejor y hacer seguimiento de tu proyecto, ¿me dejás tu nombre completo y un teléfono o WhatsApp?"
- Si ya te dio el nombre pero no el teléfono, pedí solo el teléfono
- Si ya te dio el teléfono pero no el nombre, pedí solo el nombre completo
- Una vez que tenés nombre y teléfono, no los vuelvas a pedir

Canal de conversación:
- Si el cliente está hablando por WhatsApp, podés enviarle links y decirle que visite https://inalbis.pages.dev que es nuestra página web oficial y el formulario en https://inalbis.pages.dev/formulario
- Si el cliente está hablando desde la web (chat de la página), NUNCA le mandes links a la web porque ya está ahí. En cambio guialo así: "Podés ir al botón CONSULTAR que está justo debajo de este chat, o scrolleá hasta la sección de Paquetes y tocá el botón de tu plan preferido"

Memoria del cliente:
- Cuando el cliente mencione qué tipo de negocio, ubicación o cualquier información util para la página web que tiene o quiere para su página, recordalo y usalo en toda la conversación
- Si ya sabés su info, no se lo vuelvas a preguntar
- Ejemplo: si dijo "tengo un restaurante", en el siguiente mensaje ya sabés que es un restaurante

Formulario de solicitud:
- Cuando el cliente quiera avanzar, explícale: "Para solicitar tu página web dale al botón Comenzar solicitud, que se encuentra arriba a la derecha, completás el formulario y nos ponemos en contacto enseguida, o también scrolleá hasta la sección de Paquetes, elegí el que mejor se adapta a tu negocio."

Reglas:
- Respondé siempre en español
- Sé conciso (máximo 3 párrafos cortos)
- Nunca inventes precios exactos, decí que los presupuestos son personalizados
- Si preguntan por el precio, decí que depende del proyecto y ofrecé agendar una llamada gratuita
- Usá un tono cercano, moderno y profesional
- Nunca digas que sos una IA a menos que te lo pregunten directamente.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/chat" && request.method === "POST") {
      return handleWebChat(request, env);
    }

    if (request.method === "GET") {
      const mode      = url.searchParams.get("hub.mode");
      const token     = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "POST") {
      return handleWhatsApp(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ─────────────────────────────────────────────────────────────
// HANDLER: Chatbot web
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

    // Detectar datos del cliente en el mensaje
    const detected = detectData(message);

    // Cargar perfil existente o crear uno nuevo
    let profile = await loadProfile(kvKey, env);

    // Si detectamos un teléfono nuevo, buscar si ya existe perfil en WhatsApp
    if (detected.phone && !profile.phone) {
      const waProfile = await env.CHAT_HISTORY.get(`profile:wa:${detected.phone}`);
      if (waProfile) {
        // Fusionar perfil de WhatsApp con el de la web
        const waParsed = JSON.parse(waProfile);
        profile = { ...waParsed, ...profile };
      }
      profile.phone = detected.phone;
      // Crear vínculo teléfono → sessionId para que WhatsApp encuentre la web
      await env.CHAT_HISTORY.put(`phone:${detected.phone}`, kvKey, { expirationTtl: 604800 });
    }

    if (detected.name  && !profile.name)  profile.name  = detected.name;
    if (detected.email && !profile.email) profile.email = detected.email;

    await saveProfile(kvKey, profile, env);

    // Historial
    const stored = await env.CHAT_HISTORY.get(kvKey);
    let history = stored ? JSON.parse(stored) : [];
    history.push({ role: "user", content: message });
    if (history.length > 10) history = history.slice(-10);

    const aiResponse = await callGroq(history, buildSystemPrompt(profile), env);

    history.push({ role: "assistant", content: aiResponse });
    await env.CHAT_HISTORY.put(kvKey, JSON.stringify(history), { expirationTtl: 86400 });

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

    const from          = message.from;
    const text          = message.text.body;
    const phoneNumberId = value.metadata.phone_number_id;
    const kvKey         = `wa:${from}`;

    // Cargar perfil o buscar si este número tiene perfil web
    let profile = await loadProfile(kvKey, env);

    // El teléfono de WhatsApp siempre lo sabemos
    if (!profile.phone) profile.phone = from;

    // Buscar si este número tiene sesión web vinculada
    const webKey = await env.CHAT_HISTORY.get(`phone:${from}`);
    if (webKey) {
      const webProfile = await loadProfile(webKey, env);
      // Fusionar — el perfil web puede tener nombre o email
      if (webProfile.name  && !profile.name)  profile.name  = webProfile.name;
      if (webProfile.email && !profile.email) profile.email = webProfile.email;
    }

    // Detectar datos nuevos en el mensaje
    const detected = detectData(text);
    if (detected.name  && !profile.name)  profile.name  = detected.name;
    if (detected.email && !profile.email) profile.email = detected.email;

    await saveProfile(kvKey, profile, env);

    // Historial
    const stored = await env.CHAT_HISTORY.get(kvKey);
    let history = stored ? JSON.parse(stored) : [];
    history.push({ role: "user", content: text });
    if (history.length > 10) history = history.slice(-10);

    const aiResponse = await callGroq(history, buildSystemPrompt(profile), env);

    history.push({ role: "assistant", content: aiResponse });
    await env.CHAT_HISTORY.put(kvKey, JSON.stringify(history), { expirationTtl: 86400 });

    await sendWhatsAppMessage(from, aiResponse, phoneNumberId, env);

    return new Response("OK", { status: 200 });

  } catch (err) {
    console.error("WhatsApp error:", err);
    return new Response("Error", { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────
// Detecta nombre, email y teléfono en cualquier formato
// ─────────────────────────────────────────────────────────────
function detectData(message) {
  const result = {};

  // Email
  const emailMatch = message.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) result.email = emailMatch[0];

  // Teléfono internacional — cualquier país
  const phoneMatch = message.match(/\+?[\d\s\-().]{7,20}\d/);
  if (phoneMatch) {
    const clean = phoneMatch[0].replace(/[\s\-().]/g, "");
    if (clean.length >= 7) result.phone = clean;
  }

  // Nombre completo ("me llamo X Y", "soy X Y", "mi nombre es X Y")
  const nameMatch = message.match(
    /(?:me llamo|soy|mi nombre es)\s+([A-ZÁÉÍÓÚÑA-Z][a-záéíóúña-z]+(?:\s+[A-ZÁÉÍÓÚÑA-Z][a-záéíóúña-z]+)+)/i
  );
  if (nameMatch) result.name = nameMatch[1];

  return result;
}

// ─────────────────────────────────────────────────────────────
// Carga perfil desde KV
// ─────────────────────────────────────────────────────────────
async function loadProfile(kvKey, env) {
  const stored = await env.CHAT_HISTORY.get(`profile:${kvKey}`);
  return stored ? JSON.parse(stored) : {};
}

// ─────────────────────────────────────────────────────────────
// Guarda perfil en KV (7 días)
// ─────────────────────────────────────────────────────────────
async function saveProfile(kvKey, profile, env) {
  await env.CHAT_HISTORY.put(`profile:${kvKey}`, JSON.stringify(profile), {
    expirationTtl: 604800,
  });
}

// ─────────────────────────────────────────────────────────────
// Construye system prompt con perfil del cliente
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
      model: "llama-3.3-70b-versatile",
      max_tokens: 500,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
      ],
    }),
  });

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "Disculpá, hubo un error. Intentá de nuevo.";
}

// ─────────────────────────────────────────────────────────────
// Envía mensaje por WhatsApp
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
