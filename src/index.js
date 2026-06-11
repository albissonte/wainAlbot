/**
 * WAinAlbot - WhatsApp + Web AI Bot para InAlbis Pages
 * Cloudflare Worker — src/index.js
 */

const SYSTEM_PROMPT = `Sos el asistente virtual de InAlbis Pages, una agencia de diseño web moderna y rápida.

Sobre InAlbis Pages:
- Creamos páginas web profesionales para negocios que necesitan presencia en internet
- Somos rápidos, usamos las herramientas más actuales (Cloudflare, IA, diseño moderno)
- Ofrecemos soluciones modernas y accesibles para todo tipo de negocios
- Dominio: www.inalbispages.com

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
- Si el cliente está hablando por WhatsApp, podés enviarle links e invitarle a visitar www.inalbispages.com
- Si el cliente está hablando desde la web (chat de la página), NUNCA le mandes links a la web porque ya está ahí. En cambio guialo así: "Podés ir al botón CONSULTAR que está justo debajo de este chat, o scrolleá hasta la sección de Paquetes y tocá el botón de tu plan preferido"

Memoria del negocio del cliente:
- Cuando el cliente mencione qué tipo de negocio tiene o qué quiere para su página, recordalo y usalo en toda la conversación
- Si ya sabés su negocio, no se lo vuelvas a preguntar
- Ejemplo: si dijo "tengo un restaurante", en el siguiente mensaje ya sabés que es un restaurante

Formulario de solicitud:
- Cuando el cliente quiera avanzar desde la web, explicale: "Para solicitar tu página web, scrolleá hasta la sección de Paquetes, y elegí el que mejor se adapta a tu negocio. Ahí completás el formulario y nos ponemos en contacto enseguida, o podés iniciar la solicitud al inicio de página con el botón que dice Comenzar solicitud"
- Cuando el cliente quiera avanzar desde whatsapp, enviále este link personalizado: "www.inalbispages.com/formulario/?ref=" seguido de su número de teléfono sin espacios ni símbolos. Ejemplo: www.inalbispages.com/formulario/?ref=5491112345678
Reglas:
- Respondé siempre en español o inglés (a menos que te hablen en otro idioma responde con educacion que solamente hablás inglés y español)
- Sé conciso (máximo 3 párrafos cortos)
- Los 3 planes de pagos son de 249, 499 y 899 dólares, pero decí que los presupuestos son personalizados
- Si preguntan por el precio, decí que depende del proyecto y ofrecé agendar una llamada gratuita
- Usá un tono cercano, moderno y profesional
- Nunca digas que sos una IA a menos que te lo pregunten directamente
- Tenemos un nuevo servicio de automatizaciones llamado Alby,(email,WhatsApp,Web,llamadas) si la persona te lo menciona que quiere contratarlo o que está interesado realmente le pasas mi contacto de WhatsApp listo para que me escriba con el mombre de contacto Cristian Albis+46760684744 y si no lo ves decidido le envías a la pagina www.inalbispages.com/Alby
  `;

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
    
// Endpoint para que el formulario lea el perfil por teléfono
if (url.pathname === "/profile" && request.method === "GET") {
  const phone = url.searchParams.get("phone");
  if (!phone) return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json", ...CORS } });
  const profile = await env.CHAT_HISTORY.get(`profile:wa:${phone}`);
  return new Response(profile || "{}", { headers: { "Content-Type": "application/json", ...CORS } });
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
    let profile = await loadProfile(kvKey, env);
    const detected = detectData(message);

    // Cruce por teléfono: si detectamos uno nuevo, buscar perfil de WhatsApp
    if (detected.phone && !profile.phone) {
      const waProfile = await env.CHAT_HISTORY.get(`profile:wa:${detected.phone}`);
      if (waProfile) {
        const waParsed = JSON.parse(waProfile);
        profile = { ...waParsed, ...profile };
      }
      await env.CHAT_HISTORY.put(`phone:${detected.phone}`, kvKey, { expirationTtl: 604800 });
    }

    if (detected.name             && !profile.name)             profile.name             = detected.name;
    if (detected.phone            && !profile.phone)            profile.phone            = detected.phone;
    if (detected.email            && !profile.email)            profile.email            = detected.email;
    if (detected.business_name    && !profile.business_name)    profile.business_name    = detected.business_name;
    if (detected.business_description && !profile.business_description) profile.business_description = detected.business_description;

    await saveProfile(kvKey, profile, env);

    const stored = await env.CHAT_HISTORY.get(kvKey);
    let history = stored ? JSON.parse(stored) : [];
    history.push({ role: "user", content: message });
    if (history.length > 10) history = history.slice(-10);

    const aiResponse = await callGroq(history, buildSystemPrompt(profile, "web"), env);

    history.push({ role: "assistant", content: aiResponse });
    await env.CHAT_HISTORY.put(kvKey, JSON.stringify(history), { expirationTtl: 86400 });

    // Devolver también el perfil para que el frontend lo guarde en localStorage
    return new Response(
      JSON.stringify({ reply: aiResponse, profile }),
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

    let profile = await loadProfile(kvKey, env);
    if (!profile.phone) profile.phone = from;

    // Cruce: buscar si este número tiene sesión web vinculada
    const webKey = await env.CHAT_HISTORY.get(`phone:${from}`);
    if (webKey) {
      const webProfile = await loadProfile(webKey, env);
      if (webProfile.name             && !profile.name)             profile.name             = webProfile.name;
      if (webProfile.email            && !profile.email)            profile.email            = webProfile.email;
      if (webProfile.business_name    && !profile.business_name)    profile.business_name    = webProfile.business_name;
      if (webProfile.business_description && !profile.business_description) profile.business_description = webProfile.business_description;
    }

    const detected = detectData(text);
    if (detected.name             && !profile.name)             profile.name             = detected.name;
    if (detected.email            && !profile.email)            profile.email            = detected.email;
    if (detected.business_name    && !profile.business_name)    profile.business_name    = detected.business_name;
    if (detected.business_description && !profile.business_description) profile.business_description = detected.business_description;

    await saveProfile(kvKey, profile, env);

    const stored = await env.CHAT_HISTORY.get(kvKey);
    let history = stored ? JSON.parse(stored) : [];
    history.push({ role: "user", content: text });
    if (history.length > 10) history = history.slice(-10);

    const aiResponse = await callGroq(history, buildSystemPrompt(profile, "whatsapp"), env);

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
// Detecta nombre, email, teléfono y negocio en el mensaje
// ─────────────────────────────────────────────────────────────
function detectData(message) {
  const result = {};

  // Email
  const emailMatch = message.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) result.email = emailMatch[0];

  // Teléfono internacional
  const phoneMatch = message.match(/\+?[\d\s\-().]{7,20}\d/);
  if (phoneMatch) {
    const clean = phoneMatch[0].replace(/[\s\-().]/g, "");
    if (clean.length >= 7) result.phone = clean;
  }

  // Nombre completo
  const nameMatch = message.match(
    /(?:me llamo|soy|mi nombre es)\s+([A-ZÁÉÍÓÚÑA-Z][a-záéíóúña-z]+(?:\s+[A-ZÁÉÍÓÚÑA-Z][a-záéíóúña-z]+)+)/i
  );
  if (nameMatch) result.name = nameMatch[1];

  // Tipo de negocio ("tengo un X", "mi negocio es X", "tenemos una X")
  const bizMatch = message.match(
    /(?:tengo\s+(?:un|una|el|la)|mi\s+negocio\s+es|tenemos\s+(?:un|una))\s+([a-záéíóúña-z\s]{3,40})/i
  );
  if (bizMatch) {
    result.business_name = bizMatch[1].trim();
    result.business_description = message;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// KV helpers
// ─────────────────────────────────────────────────────────────
async function loadProfile(kvKey, env) {
  const stored = await env.CHAT_HISTORY.get(`profile:${kvKey}`);
  return stored ? JSON.parse(stored) : {};
}

async function saveProfile(kvKey, profile, env) {
  await env.CHAT_HISTORY.put(`profile:${kvKey}`, JSON.stringify(profile), {
    expirationTtl: 604800,
  });
}

// ─────────────────────────────────────────────────────────────
// System prompt con perfil y canal
// ─────────────────────────────────────────────────────────────
function buildSystemPrompt(profile, canal) {
  let prompt = SYSTEM_PROMPT;
  prompt += `\n\nCanal actual: ${canal === "web" ? "Chat de la página web — NO envíes links a la web" : "WhatsApp"}`;

  if (profile.name || profile.email || profile.phone || profile.business_name) {
    prompt += "\n\nDatos conocidos de este cliente:";
    if (profile.name)                 prompt += `\n- Nombre: ${profile.name}`;
    if (profile.email)                prompt += `\n- Email: ${profile.email}`;
    if (profile.phone)                prompt += `\n- Teléfono: ${profile.phone}`;
    if (profile.business_name)        prompt += `\n- Negocio: ${profile.business_name}`;
    if (profile.business_description) prompt += `\n- Descripción: ${profile.business_description}`;
    prompt += "\nUsá su nombre y recordá su negocio en toda la conversación. No vuelvas a pedir datos que ya tenés.";
  }
  return prompt;
}

// ─────────────────────────────────────────────────────────────
// Groq
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
// WhatsApp
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
