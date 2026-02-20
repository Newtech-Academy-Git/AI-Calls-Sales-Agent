/**
 * NewTech Academy â AI Sales Call Backend
 * ==========================================
 * Connects: Fireberry CRM â Vapi.ai â Twilio
 *
 * Endpoints:
 *   GET  /                        â serves ai_call_button.html
 *   GET  /api/lead/:recordId      â fetch lead from Fireberry API
 *   POST /api/call                â initiate outbound AI call via Vapi
 *   GET  /api/call-status/:callId â get live call status
 *   POST /webhook/vapi            â receives Vapi events (end-of-call, etc.)
 */

require('dotenv').config();
const express    = require('express');
const fetch      = require('node-fetch');
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// CORS â allow Fireberry to call this server
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const CONFIG = {
  FIREBERRY_API_KEY:   process.env.FIREBERRY_API_KEY   || 'YOUR_FIREBERRY_API_KEY',
  FIREBERRY_BASE_URL:  'https://api.fireberry.com/api',
  VAPI_API_KEY:        process.env.VAPI_API_KEY        || 'YOUR_VAPI_API_KEY',
  VAPI_ASSISTANT_ID:   process.env.VAPI_ASSISTANT_ID   || 'YOUR_VAPI_ASSISTANT_ID',
  VAPI_PHONE_NUMBER_ID:process.env.VAPI_PHONE_NUMBER_ID|| 'YOUR_VAPI_PHONE_NUMBER_ID',
  VAPI_BASE_URL:       'https://api.vapi.ai',
  WEBHOOK_SECRET:      process.env.WEBHOOK_SECRET      || '',
};

const callStore = new Map();

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'ai_call_button.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.send('<h2>ai_call_button.html not found</h2>');
  }
});

app.get('/api/lead/:recordId', async (req, res) => {
  const { recordId } = req.params;
  try {
    const fbRes = await fetch(
      `${CONFIG.FIREBERRY_BASE_URL}/record/1/${recordId}`,
      { headers: { 'tokenid': CONFIG.FIREBERRY_API_KEY, 'Content-Type': 'application/json' } }
    );
    if (!fbRes.ok) return res.status(fbRes.status).json({ error: `Fireberry returned ${fbRes.status}` });
    const raw = await fbRes.json();
    const lead = normalizeLead(raw, recordId);
    console.log(`[lead] Fetched: ${lead.name} | ${lead.phone} | ${lead.campaign}`);
    res.json(lead);
  } catch (err) {
    console.error('[lead] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/call', async (req, res) => {
  const { recordId, phone, name, campaign, adset, status, statusDetail, city, source, company, whatsappUrl, email } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  const e164Phone = toE164(phone);
  if (!e164Phone) return res.status(400).json({ error: `Invalid phone number: ${phone}` });
  console.log(`[call] Starting call to ${name} (${e164Phone}) | Campaign: ${campaign} | City: ${city}`);
  const assistantOverrides = buildAssistantOverrides({ name, campaign, adset, status, statusDetail, city, source, company, whatsappUrl });
  try {
    const vapiRes = await fetch(`${CONFIG.VAPI_BASE_URL}/call/phone`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CONFIG.VAPI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assistantId: CONFIG.VAPI_ASSISTANT_ID,
        phoneNumberId: CONFIG.VAPI_PHONE_NUMBER_ID,
        assistantOverrides,
        customer: { number: e164Phone, name: name || 'ÙÙØ¯' },
        metadata: { recordId, name, phone: e164Phone, campaign, adset, status, statusDetail, city, source, company, whatsappUrl }
      })
    });
    if (!vapiRes.ok) {
      const errBody = await vapiRes.text();
      console.error('[call] Vapi error:', errBody);
      return res.status(vapiRes.status).json({ error: `Vapi error: ${errBody}` });
    }
    const callData = await vapiRes.json();
    const callId = callData.id;
    callStore.set(callId, { callId, recordId, status: 'initiated', leadName: name, phone: e164Phone, campaign, city, startedAt: new Date().toISOString() });
    console.log(`[call] Created Vapi call ${callId}`);
    res.json({ callId, status: 'initiated' });
  } catch (err) {
    console.error('[call] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/call-status/:callId', async (req, res) => {
  const { callId } = req.params;
  const stored = callStore.get(callId);
  if (stored && stored.status === 'ended') return res.json(stored);
  try {
    const vapiRes = await fetch(`${CONFIG.VAPI_BASE_URL}/call/${callId}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.VAPI_API_KEY}` }
    });
    if (!vapiRes.ok) return res.json({ status: 'unknown' });
    const data = await vapiRes.json();
    const statusMap = { 'queued': 'initiated', 'ringing': 'ringing', 'in-progress': 'in-progress', 'forwarding': 'in-progress', 'ended': 'ended' };
    const mapped = statusMap[data.status] || data.status;
    const existing = callStore.get(callId) || {};
    callStore.set(callId, { ...existing, status: mapped });
    res.json({ callId, status: mapped, durationSeconds: data.endedAt ? Math.round((new Date(data.endedAt) - new Date(data.startedAt)) / 1000) : undefined });
  } catch (err) { res.json({ status: 'unknown', error: err.message }); }
});

app.post('/webhook/vapi', async (req, res) => {
  const event = req.body;
  console.log(`[webhook] Event: ${event.message?.type || 'unknown'}`);
  if (event.message?.type === 'end-of-call-report') await handleEndOfCall(event.message);
  else if (event.message?.type === 'status-update') handleStatusUpdate(event.message);
  res.sendStatus(200);
});

async function handleEndOfCall(msg) {
  const call = msg.call || {};
  const callId = call.id;
  const analysis = msg.analysis || {};
  const metadata = call.metadata || {};
  const outcome = analysis.structuredData?.outcome || 'UNKNOWN';
  const interestLevel = analysis.structuredData?.interestLevel || 'none';
  const mainObjection = analysis.structuredData?.mainObjection;
  const customerBg = analysis.structuredData?.customerBackground;
  const whatsappSent = analysis.structuredData?.whatsappSent || false;
  const hasBDI = analysis.structuredData?.hasBDIIssue || false;
  const summary = analysis.summary || '';
  const transcript = msg.transcript || '';
  const duration = call.endedAt ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000) : 0;
  console.log(`[webhook] Call ended: ${callId} | Outcome: ${outcome} | Interest: ${interestLevel}`);
  callStore.set(callId, { callId, recordId: metadata.recordId, status: 'ended', outcome, interestLevel, mainObjection, customerBackground: customerBg, summary, durationSeconds: duration, whatsappSent, hasBDIIssue: hasBDI, endedAt: call.endedAt });
  if (metadata.recordId) {
    await updateFireberry(metadata.recordId, { outcome, interestLevel, mainObjection, customerBackground: customerBg, summary, duration, whatsappSent, hasBDI });
  }
}

function handleStatusUpdate(msg) {
  const callId = msg.call?.id;
  if (!callId) return;
  const existing = callStore.get(callId) || {};
  callStore.set(callId, { ...existing, status: msg.status });
  console.log(`[webhook] Status update: ${callId} â ${msg.status}`);
}

async function updateFireberry(recordId, data) {
  const { outcome, interestLevel, summary, duration, hasBDI, mainObjection, whatsappSent } = data;
  const statusMap = {
    ENROLLED: { status: '× ×¨×©×', statusDetail: '×¢××¨ ×ª×©××× ×¨××©×× ×××¦×××' },
    WHATSAPP_SENT_INTERESTED: { status: '×××¢××¨ ××\'×× ××', statusDetail: '××× ×¨×××× ×× â × ×©×× WhatsApp' },
    CALLBACK_REQUESTED: { status: '×××¢××¨ ××\'×× ××', statusDetail: '××× ×¨×××× ×× â ×××§×© ×××¨×' },
    FINANCIAL_BLOCKER: { status: '×××¢××¨ ××\'×× ××', statusDetail: '××¢×××ª BDI/××©×¨×× â ××¨××© × ×¦×× ×× ××©×' },
    NOT_INTERESTED: { status: '×× ×¨×××× ××', statusDetail: '×× ××¢×× ×××' },
    NO_ANSWER: { status: '××¨× ×××¤×', statusDetail: '×× ×¢× × â ×××ª×× ××××× ××××¨' },
    WRONG_NUMBER: { status: '×× ×¨×××× ××', statusDetail: '××× ××¤×× / ××¡×¤×¨ ×©×××' },
  };
  const mapped = statusMap[outcome] || { statusDetail: `AI call: ${outcome}` };
  const durationMin = duration ? Math.floor(duration / 60) : 0;
  const durationSec = duration ? duration % 60 : 0;
  const noteLines = [
    `×©×××ª AI â ${new Date().toLocaleDateString('he-IL')}`,
    `××©×: ${durationMin}:${String(durationSec).padStart(2,'0')} ××§××ª`,
    `×ª××¦××: ${outcome}`,
    `×¨××ª ×¢× ×××: ${interestLevel || '×× ××××¢'}`,
    mainObjection ? `××ª× ××××ª ×¢××§×¨××ª: ${mainObjection}` : null,
    hasBDI ? `××¢×××ª BDI/××©×¨×× â × ××¨×© ×××¨××¨` : null,
    whatsappSent ? `WhatsApp × ×©××` : null,
    summary ? `\n×¡××××:\n${summary}` : null,
  ].filter(Boolean).join('\n');
  const patchBody = {
    ...(mapped.status ? { status: mapped.status } : {}),
    ...(mapped.statusDetail ? { pcfStatusDetails: mapped.statusDetail } : {}),
    description: noteLines,
  };
  try {
    const res = await fetch(`${CONFIG.FIREBERRY_BASE_URL}/record/1/${recordId}`, {
      method: 'PATCH',
      headers: { 'tokenid': CONFIG.FIREBERRY_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(patchBody)
    });
    const responseText = await res.text();
    if (!res.ok) { console.error(`[fireberry] Update failed (${res.status}):`, responseText); console.error('[fireberry] Tried to PATCH:', JSON.stringify(patchBody)); }
    else { console.log(`[fireberry] Updated record ${recordId} â ${mapped.status || 'note added'}`); }
  } catch(err) { console.error('[fireberry] Update error:', err.message); }
}

function toE164(phone) {
  if (!phone) return null;
  const clean = phone.replace(/[\s\-\(\)\.]/g, '');
  if (/^\+972/.test(clean)) return clean;
  if (/^972/.test(clean)) return '+' + clean;
  if (/^0[5-9]/.test(clean)) return '+972' + clean.slice(1);
  if (/^[5-9]\d{8}$/.test(clean)) return '+972' + clean;
  return null;
}

function normalizeLead(raw, recordId) {
  const fields = (raw.data && raw.data.Record) || raw.data || raw.record || raw.fields || raw;
  return {
    recordId: recordId || fields.accountid || '',
    name: fields.accountname || '',
    phone: fields.telephone1 || '',
    email: fields.emailaddress1 || '',
    campaign: fields.pcfCampign || '',
    adset: fields.pcfAdset || '',
    status: fields.status || '',
    statusDetail: fields.pcfStatusDetailsname || '',
    subStatus: fields.pcfsystemfield3name || '',
    city: fields.billingcity || '',
    source: fields.pcfsystemfield27name || '',
    whatsappUrl: fields.pcfsystemfield21 || '',
    company: fields.pcfCompanyname || '',
  };
}

function buildAssistantOverrides({ name, campaign, status, statusDetail, city, source, adset, company, whatsappUrl }) {
  const firstName = (name || '').trim().split(/\s+/)[0] || '';
  const isBDO = (campaign || company || '').toLowerCase().includes('bdo');
  const isFullStack = (campaign || '').toLowerCase().includes('full stack') || (campaign || '').toLowerCase().includes('fullstack');
  const isQA = (campaign || '').toLowerCase().includes('qa') || (campaign || '').toLowerCase().includes('××××§××ª');
  let courseHint = '';
  if (isBDO) courseHint = '×××× ××××¢ ××§××¤××× BDO â ×××ª×× ×¨×§×¢ ××¨××××ª ××©×××/××¡×¤××.';
  else if (isQA) courseHint = '×××× ××××¢ ××§××¤××× QA â ×××× ××§××¨×¡ QA Automation.';
  else if (isFullStack) courseHint = '×××× ××××¢ ××§××¤××× Full Stack â ×××× ××§××¨×¡ Full Stack.';
  const contextBlock = [
    'âââ ××××¢ ×¢× ×××× (×××× ××××××××ª ××¤× × ××©×××) âââ',
    `×©× ×××: ${name || '×× ××××¢'}`,
    `×©× ×¤×¨××: ${firstName || '×× ××××¢'}`,
    `×¢××¨: ${city || '×× ××××¢'}`,
    `×§××¤×××: ${campaign || '×× ××××¢'}`,
    `Ad Set: ${adset || '×× ××××¢'}`,
    `××§××¨: ${source || '×× ××××¢'}`,
    `×¡××××¡ CRM: ${status || '×××©'}`,
    statusDetail ? `×¤××¨××: ${statusDetail}` : null,
    whatsappUrl ? `WhatsApp: ${whatsappUrl} (×©×× ××××¨ ×××××© ×¢× ×××)` : null,
    courseHint ? `×¨××: ${courseHint}` : null,
    'âââââââââââââââââââââââââââââââââââââââââââââââ',
  ].filter(Boolean).join('\n');
  return {
    firstMessage: firstName ? `Ø£ÙÙØ ÙØ¹Ù ${firstName}Ø` : 'Ø£ÙÙØ ÙÙÙ ÙØ¹ÙØ',
    model: { messages: [{ role: 'system', content: contextBlock }] }
  };
}

app.listen(PORT, () => {
  console.log(`\nNewTech AI Call Server running on port ${PORT}`);
  console.log(`   Button UI:  http://localhost:${PORT}/`);
  console.log(`   Call API:   POST http://localhost:${PORT}/api/call`);
  console.log(`   Vapi hook:  POST http://localhost:${PORT}/webhook/vapi`);
  console.log('\nConfig check:');
  console.log(`   Fireberry API Key: ${CONFIG.FIREBERRY_API_KEY !== 'YOUR_FIREBERRY_API_KEY' ? 'SET' : 'NOT SET'}`);
  console.log(`   Vapi API Key:      ${CONFIG.VAPI_API_KEY !== 'YOUR_VAPI_API_KEY' ? 'SET' : 'NOT SET'}`);
  console.log(`   Vapi Assistant ID: ${CONFIG.VAPI_ASSISTANT_ID !== 'YOUR_VAPI_ASSISTANT_ID' ? 'SET' : 'NOT SET'}`);
  console.log(`   Phone Number ID:   ${CONFIG.VAPI_PHONE_NUMBER_ID !== 'YOUR_VAPI_PHONE_NUMBER_ID' ? 'SET' : 'NOT SET'}`);
});