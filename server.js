/**
 * NewTech Academy – AI Sales Call Backend
 * ==========================================
 * Connects: Fireberry CRM ↔ Vapi.ai ↔ Voicenter
 *
 * Endpoints:
 *   GET  /                        → serves ai_call_button.html
 *   GET  /api/lead/:recordId      → fetch lead from Fireberry API
 *   POST /api/call                → initiate outbound AI call via Vapi
 *   GET  /api/call-status/:callId → get live call status
 *   POST /webhook/vapi            → receives Vapi events (end-of-call, etc.)
 */

require('dotenv').config();
const express    = require('express');
const fetch      = require('node-fetch');
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// CORS – allow Fireberry to call this server
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ============================================================
// ⚙️  CONFIG – מלא כאן את המפתחות שלך (או השתמש ב-.env)
// ============================================================
const CONFIG = {
  // Fireberry
  FIREBERRY_API_KEY:   process.env.FIREBERRY_API_KEY   || 'YOUR_FIREBERRY_API_KEY',
  FIREBERRY_BASE_URL:  'https://api.fireberry.com/api',

  // Vapi
  VAPI_API_KEY:        process.env.VAPI_API_KEY        || 'YOUR_VAPI_API_KEY',
  VAPI_ASSISTANT_ID:   process.env.VAPI_ASSISTANT_ID   || 'YOUR_VAPI_ASSISTANT_ID',
  VAPI_PHONE_NUMBER_ID:process.env.VAPI_PHONE_NUMBER_ID|| 'YOUR_VAPI_PHONE_NUMBER_ID',
  VAPI_BASE_URL:       'https://api.vapi.ai',

  // Webhook secret (optional – to verify Vapi requests)
  WEBHOOK_SECRET:      process.env.WEBHOOK_SECRET      || '',
};

// In-memory call store (replace with DB for production)
const callStore = new Map(); // callId → { status, leadData, outcome, ... }

// ============================================================
// ROUTES
// ============================================================

/** Serve the HTML button */
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'ai_call_button.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.send('<h2>ai_call_button.html not found</h2>');
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/lead/:recordId
// Fetches lead data from Fireberry and returns a clean object
// ────────────────────────────────────────────────────────────
app.get('/api/lead/:recordId', async (req, res) => {
  const { recordId } = req.params;

  try {
    const fbRes = await fetch(
      `${CONFIG.FIREBERRY_BASE_URL}/record/1/${recordId}`,
      {
        headers: {
          'tokenid': CONFIG.FIREBERRY_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!fbRes.ok) {
      return res.status(fbRes.status).json({
        error: `Fireberry returned ${fbRes.status}`
      });
    }

    const raw = await fbRes.json();

    // Normalize Fireberry response to a clean lead object
    const lead = normalizeLead(raw, recordId);
    console.log(`[lead] Fetched: ${lead.name} | ${lead.phone} | ${lead.campaign}`);

    res.json(lead);
  } catch (err) {
    console.error('[lead] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// POST /api/call
// Body: full lead object from normalizeLead() or manual fields
// Initiates outbound call via Vapi
// ────────────────────────────────────────────────────────────
app.post('/api/call', async (req, res) => {
  const {
    recordId,
    phone,
    name,
    campaign,
    adset,
    status,
    statusDetail,
    city,
    source,
    company,
    whatsappUrl,
    email
  } = req.body;

  if (!phone) {
    return res.status(400).json({ error: 'phone is required' });
  }

  const e164Phone = toE164(phone);
  if (!e164Phone) {
    return res.status(400).json({ error: `Invalid phone number: ${phone}` });
  }

  console.log(`[call] 📞 Starting call to ${name} (${e164Phone}) | Campaign: ${campaign} | City: ${city}`);

  // Build assistant overrides – injects lead context into the AI
  const assistantOverrides = buildAssistantOverrides({
    name, campaign, adset, status, statusDetail, city, source, company, whatsappUrl
  });

  try {
    const vapiRes = await fetch(`${CONFIG.VAPI_BASE_URL}/call/phone`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.VAPI_API_KEY}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        assistantId:      CONFIG.VAPI_ASSISTANT_ID,
        phoneNumberId:    CONFIG.VAPI_PHONE_NUMBER_ID,
        assistantOverrides,
        customer: {
          number: e164Phone,
          name:   name || 'ليد'
        },
        // Metadata flows through to webhook end-of-call-report
        metadata: {
          recordId,
          name,
          phone:        e164Phone,
          campaign,
          adset,
          status,
          statusDetail,
          city,
          source,
          company,
          whatsappUrl
        }
      })
    });

    if (!vapiRes.ok) {
      const errBody = await vapiRes.text();
      console.error('[call] Vapi error:', errBody);
      return res.status(vapiRes.status).json({
        error: `Vapi error: ${errBody}`
      });
    }

    const callData = await vapiRes.json();
    const callId   = callData.id;

    // Store call info in memory
    callStore.set(callId, {
      callId,
      recordId,
      status:   'initiated',
      leadName: name,
      phone:    e164Phone,
      campaign,
      city,
      startedAt: new Date().toISOString()
    });

    console.log(`[call] ✅ Created Vapi call ${callId}`);
    res.json({ callId, status: 'initiated' });

  } catch (err) {
    console.error('[call] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// GET /api/call-status/:callId
// Returns current call status (polling endpoint for frontend)
// ────────────────────────────────────────────────────────────
app.get('/api/call-status/:callId', async (req, res) => {
  const { callId } = req.params;

  // First check our store (updated by webhooks)
  const stored = callStore.get(callId);
  if (stored && stored.status === 'ended') {
    return res.json(stored);
  }

  // Otherwise, fetch live from Vapi
  try {
    const vapiRes = await fetch(`${CONFIG.VAPI_BASE_URL}/call/${callId}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.VAPI_API_KEY}` }
    });

    if (!vapiRes.ok) return res.json({ status: 'unknown' });

    const data = await vapiRes.json();

    // Map Vapi status to our status
    const statusMap = {
      'queued':      'initiated',
      'ringing':     'ringing',
      'in-progress': 'in-progress',
      'forwarding':  'in-progress',
      'ended':       'ended',
    };

    const mapped = statusMap[data.status] || data.status;

    // Update store
    const existing = callStore.get(callId) || {};
    callStore.set(callId, { ...existing, status: mapped });

    res.json({
      callId,
      status:          mapped,
      durationSeconds: data.endedAt
        ? Math.round((new Date(data.endedAt) - new Date(data.startedAt)) / 1000)
        : undefined
    });
  } catch (err) {
    res.json({ status: 'unknown', error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// POST /webhook/vapi
// Receives events from Vapi (end-of-call-report, etc.)
// ────────────────────────────────────────────────────────────
app.post('/webhook/vapi', async (req, res) => {
  const event = req.body;
  console.log(`[webhook] Event: ${event.message?.type || 'unknown'}`);

  if (event.message?.type === 'end-of-call-report') {
    await handleEndOfCall(event.message);
  } else if (event.message?.type === 'status-update') {
    handleStatusUpdate(event.message);
  }

  res.sendStatus(200);
});

// ============================================================
// HANDLERS
// ============================================================

async function handleEndOfCall(msg) {
  const call      = msg.call || {};
  const callId    = call.id;
  const analysis  = msg.analysis || {};
  const metadata  = call.metadata || {};

  const outcome       = analysis.structuredData?.outcome       || 'UNKNOWN';
  const interestLevel = analysis.structuredData?.interestLevel || 'none';
  const mainObjection = analysis.structuredData?.mainObjection;
  const customerBg    = analysis.structuredData?.customerBackground;
  const whatsappSent  = analysis.structuredData?.whatsappSent  || false;
  const hasBDI        = analysis.structuredData?.hasBDIIssue   || false;
  const summary       = analysis.summary || '';
  const transcript    = msg.transcript || '';
  const duration      = call.endedAt
    ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000)
    : 0;

  console.log(`[webhook] Call ended: ${callId} | Outcome: ${outcome} | Interest: ${interestLevel}`);

  // Update store
  callStore.set(callId, {
    callId,
    recordId:          metadata.recordId,
    status:            'ended',
    outcome,
    interestLevel,
    mainObjection,
    customerBackground: customerBg,
    summary,
    durationSeconds:   duration,
    whatsappSent,
    hasBDIIssue:       hasBDI,
    endedAt:           call.endedAt
  });

  // Update Fireberry if we have a record ID
  if (metadata.recordId) {
    await updateFireberry(metadata.recordId, {
      outcome,
      interestLevel,
      mainObjection,
      customerBackground: customerBg,
      summary,
      duration,
      whatsappSent,
      hasBDI
    });
  }
}

function handleStatusUpdate(msg) {
  const callId = msg.call?.id;
  if (!callId) return;
  const existing = callStore.get(callId) || {};
  const status   = msg.status;
  callStore.set(callId, { ...existing, status });
  console.log(`[webhook] Status update: ${callId} → ${status}`);
}

// ============================================================
// FIREBERRY UPDATE
// Maps Vapi outcome → Fireberry status fields
// ============================================================
async function updateFireberry(recordId, data) {
  const { outcome, interestLevel, summary, duration, hasBDI, mainObjection, whatsappSent } = data;

  // ── Map outcome → Fireberry status + detail ────────────────
  // These are the Hebrew status TEXT values seen in the live CRM.
  // ⚠️  If Fireberry rejects text values and needs numeric IDs,
  //     open any lead → F12 → PATCH call → see what the status
  //     field actually sends. Usually it's a number like "3".
  const statusMap = {
    ENROLLED:                 { status: 'נרשם',           statusDetail: 'עבר תשלום ראשון בהצלחה' },
    WHATSAPP_SENT_INTERESTED: { status: 'הועבר לג\'ונגל', statusDetail: 'ליד רלוונטי – נשלח WhatsApp' },
    CALLBACK_REQUESTED:       { status: 'הועבר לג\'ונגל', statusDetail: 'ליד רלוונטי – ביקש חזרה' },
    FINANCIAL_BLOCKER:        { status: 'הועבר לג\'ונגל', statusDetail: 'בעיית BDI/אשראי – דרוש נציג אנושי' },
    NOT_INTERESTED:           { status: 'לא רלוונטי',     statusDetail: 'לא מעוניין' },
    NO_ANSWER:                { status: 'טרם טופל',       statusDetail: 'לא ענה – ממתין לחיוג חוזר' },
    WRONG_NUMBER:             { status: 'לא רלוונטי',     statusDetail: 'ליד כפול / מספר שגוי' },
  };

  const mapped = statusMap[outcome] || { statusDetail: `AI call: ${outcome}` };

  // ── Build note text ────────────────────────────────────────
  const durationMin = duration ? Math.floor(duration / 60) : 0;
  const durationSec = duration ? duration % 60 : 0;
  const noteLines = [
    `📞 שיחת AI – ${new Date().toLocaleDateString('he-IL')}`,
    `⏱ משך: ${durationMin}:${String(durationSec).padStart(2,'0')} דקות`,
    `🎯 תוצאה: ${outcome}`,
    `⭐ רמת עניין: ${interestLevel || 'לא ידוע'}`,
    mainObjection ? `🚧 התנגדות עיקרית: ${mainObjection}` : null,
    hasBDI        ? `⚠️ בעיית BDI/אשראי – נדרש בירור` : null,
    whatsappSent  ? `✅ WhatsApp נשלח` : null,
    summary       ? `\n📝 סיכום:\n${summary}` : null,
  ].filter(Boolean).join('\n');

  // ── PATCH to Fireberry ─────────────────────────────────────
  // Fields confirmed from live JSON (Feb 2026):
  //   status               → סטטוס
  //   pcfStatusDetailsname → פירוט סטטוס  ← but to WRITE use "pcfStatusDetails"
  //   description          → הערות (freetext note field – most CRMs use this)
  //
  // ⚠️ "pcfStatusDetailsname" is the READ field (display value).
  //    To WRITE a lookup field in Fireberry, use the field WITHOUT "name" suffix:
  //    e.g. "pcfStatusDetails" or check F12 → XHR → PATCH body for the exact key.
  const patchBody = {
    ...(mapped.status       ? { status: mapped.status }                         : {}),
    ...(mapped.statusDetail ? { pcfStatusDetails: mapped.statusDetail }         : {}),
    description: noteLines,  // שדה הערות חופשי
  };

  try {
    const res = await fetch(`${CONFIG.FIREBERRY_BASE_URL}/record/1/${recordId}`, {
      method: 'PATCH',
      headers: {
        'tokenid':      CONFIG.FIREBERRY_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(patchBody)
    });

    const responseText = await res.text();

    if (!res.ok) {
      console.error(`[fireberry] ❌ Update failed (${res.status}):`, responseText);
      // Log what we tried to send so it's easy to debug field name issues
      console.error('[fireberry] Tried to PATCH:', JSON.stringify(patchBody));
    } else {
      console.log(`[fireberry] ✅ Updated record ${recordId} → ${mapped.status || 'note added'}`);
    }
  } catch(err) {
    console.error('[fireberry] Update error:', err.message);
  }
}

// ============================================================
// HELPERS
// ============================================================

/** Convert Israeli phone number to E.164 (+972...) */
function toE164(phone) {
  if (!phone) return null;
  const clean = phone.replace(/[\s\-\(\)\.]/g, '');

  if (/^\+972/.test(clean))   return clean;           // already +972XX
  if (/^972/.test(clean))     return '+' + clean;     // 972XX → +972XX
  if (/^0[5-9]/.test(clean))  return '+972' + clean.slice(1); // 05X → +9725X
  if (/^[5-9]\d{8}$/.test(clean)) return '+972' + clean;  // 5XXXXXXXX

  return null;
}

/** Normalize Fireberry API response to a clean lead object */
function normalizeLead(raw, recordId) {
  // Fireberry wraps the record in data.Record (capital R!) — support multiple shapes
  const fields = (raw.data && raw.data.Record) || raw.data || raw.record || raw.fields || raw;

  // ── Real Fireberry field names (verified from live JSON, Feb 2026) ──
  // accountname          → שם לקוח (full name)
  // telephone1           → טלפון ראשי
  // emailaddress1        → דואר אלקטרוני
  // pcfCampign           → קמפיין  (⚠️ typo in Fireberry – "Campign" not "Campaign")
  // pcfAdset             → Ad Set
  // status               → סטטוס (the raw status value stored in Fireberry)
  // pcfStatusDetailsname → פירוט סטטוס (e.g. "עבר תשלום ראשון בהצלחה")
  // pcfsystemfield3name  → תת-סטטוס שלישי
  // billingcity          → עיר
  // pcfsystemfield27name → מקור (Facebook / Google / etc.)
  // pcfsystemfield21     → קישור WhatsApp (pre-built by Fireberry!)
  // pcfCompanyname       → חברה (Newtech Academy / BDO)
  // accountid            → GUID (for API calls)

  return {
    recordId:      recordId || fields.accountid || '',
    name:          fields.accountname            || '',
    phone:         fields.telephone1             || '',
    email:         fields.emailaddress1          || '',
    campaign:      fields.pcfCampign             || '',   // ⚠️ note the typo
    adset:         fields.pcfAdset               || '',
    status:        fields.status                 || '',
    statusDetail:  fields.pcfStatusDetailsname   || '',
    subStatus:     fields.pcfsystemfield3name    || '',
    city:          fields.billingcity            || '',
    source:        fields.pcfsystemfield27name   || '',   // Facebook / Google
    whatsappUrl:   fields.pcfsystemfield21       || '',   // ready-made WA link
    company:       fields.pcfCompanyname         || '',
    // raw: raw // uncomment for debugging
  };
}

function getField(obj, keys) {
  if (!obj) return '';
  for (const key of keys) {
    // Try exact match
    if (obj[key] !== undefined && obj[key] !== null) {
      const val = obj[key];
      // If it's an object with a 'name' or 'value' property
      if (typeof val === 'object' && val !== null) {
        return val.name || val.value || val.label || JSON.stringify(val);
      }
      return String(val);
    }
    // Case-insensitive search
    const lower = key.toLowerCase();
    const found = Object.keys(obj).find(k => k.toLowerCase() === lower);
    if (found && obj[found] !== null && obj[found] !== undefined) {
      const val = obj[found];
      if (typeof val === 'object') return val.name || val.value || '';
      return String(val);
    }
  }
  return '';
}

/**
 * Build assistant overrides – injects lead context into Vapi before the call.
 * Vapi supports: firstMessage, system prompt variable substitution, metadata.
 */
function buildAssistantOverrides({ name, campaign, status, statusDetail, city, source, adset, company, whatsappUrl }) {
  // Extract first name (works for Arabic names like "مارون حوا" → "مارون"
  // or Hebrew names like "עאזר שקור" → "עאזר")
  const firstName = (name || '').trim().split(/\s+/)[0] || '';

  // Detect lead type from campaign/company for tailored pitch
  const isBDO        = (campaign || company || '').toLowerCase().includes('bdo');
  const isFullStack  = (campaign || '').toLowerCase().includes('full stack') ||
                       (campaign || '').toLowerCase().includes('fullstack');
  const isQA         = (campaign || '').toLowerCase().includes('qa') ||
                       (campaign || '').toLowerCase().includes('בדיקות');

  let courseHint = '';
  if (isBDO)       courseHint = 'הליד הגיע מקמפיין BDO – ייתכן רקע בראיית חשבון/כספים. שאל על עבודתו הנוכחית.';
  else if (isQA)   courseHint = 'הליד הגיע מקמפיין QA – כוון לקורס QA Automation.';
  else if (isFullStack) courseHint = 'הליד הגיע מקמפיין Full Stack – כוון לקורס Full Stack.';

  // Build context block to prepend to system prompt
  const contextBlock = [
    '═══ מידע על הליד (הוזן אוטומטית לפני השיחה) ═══',
    `שם מלא:    ${name          || 'לא ידוע'}`,
    `שם פרטי:   ${firstName     || 'לא ידוע'}`,
    `עיר:       ${city          || 'לא ידוע'}`,
    `קמפיין:    ${campaign      || 'לא ידוע'}`,
    `Ad Set:    ${adset         || 'לא ידוע'}`,
    `מקור:      ${source        || 'לא ידוע'}`,
    `סטטוס CRM: ${status        || 'חדש'}`,
    statusDetail ? `פירוט:     ${statusDetail}` : null,
    whatsappUrl  ? `WhatsApp:  ${whatsappUrl}  (שלח לאחר גיבוש עניין)` : null,
    courseHint   ? `💡 רמז:    ${courseHint}` : null,
    '═══════════════════════════════════════════════',
  ].filter(Boolean).join('\n');

  return {
    // Override the first message with the lead's first name
    firstMessage: firstName
      ? `ألو، معي ${firstName}؟`
      : 'ألو، مين معي؟',

    // Pass lead context as metadata so the Vapi system prompt stays intact.
    // The full system prompt (Sami's persona, call flow, etc.) lives in Vapi dashboard.
    // DO NOT override model.messages – that replaces the entire system prompt!
    metadata: {
      leadName:      name      || '',
      firstName:     firstName || '',
      campaign:      campaign  || '',
      city:          city      || '',
      source:        source    || '',
      status:        status    || '',
      statusDetail:  statusDetail || '',
      adset:         adset     || '',
      company:       company   || '',
      whatsappUrl:   whatsappUrl || '',
      courseHint:    courseHint || '',
      contextBlock:  contextBlock
    }
  };
}

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`\n🚀 NewTech AI Call Server running on port ${PORT}`);
  console.log(`   Button UI:  http://localhost:${PORT}/`);
  console.log(`   Call API:   POST http://localhost:${PORT}/api/call`);
  console.log(`   Vapi hook:  POST http://localhost:${PORT}/webhook/vapi`);
  console.log('\n⚙️  Config check:');
  console.log(`   Fireberry API Key: ${CONFIG.FIREBERRY_API_KEY !== 'YOUR_FIREBERRY_API_KEY' ? '✅' : '❌ NOT SET'}`);
  console.log(`   Vapi API Key:      ${CONFIG.VAPI_API_KEY      !== 'YOUR_VAPI_API_KEY'      ? '✅' : '❌ NOT SET'}`);
  console.log(`   Vapi Assistant ID: ${CONFIG.VAPI_ASSISTANT_ID !== 'YOUR_VAPI_ASSISTANT_ID' ? '✅' : '❌ NOT SET'}`);
  console.log(`   Phone Number ID:   ${CONFIG.VAPI_PHONE_NUMBER_ID !== 'YOUR_VAPI_PHONE_NUMBER_ID' ? '✅' : '❌ NOT SET'}`);
});
