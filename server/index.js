'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const app = express();
const OPENCLAW_BIN = process.env.OPENCLAW_PATH || 'openclaw';
const LOG_PATH = path.join(__dirname, '..', 'data', 'requests.log');

app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/public')));

app.post('/api/ai-quote', async (req, res) => {
  const startTime = Date.now();
  try {
    const { brand, model, cpu, ram, storage, condition, keyboard, region, battery, quantity } = req.body;
    const specs = [brand, model, cpu, ram, storage, condition, keyboard && 'Keyboard: ' + keyboard, region && 'Region: ' + region, battery && 'Battery: ' + battery, quantity && 'Quantity: ' + quantity].filter(Boolean).join(', ');
    if (!specs) return res.status(400).json({ ok: false, error: 'No device specs provided' });

    const sessionId = `qq-${Date.now()}`;
    const prompt = `Price this device: ${specs}. IMPORTANT: Return your pricing analysis as plain text in your response. Do NOT use any tools — use your loaded knowledge from TOOLS.md and SOUL.md directly.`;
    const args = ['agent', '--agent', 'main', '--session-id', sessionId, '-m', prompt, '--json', '--thinking', 'medium'];
    const { stdout, stderr } = await execFileAsync(OPENCLAW_BIN, args, {
      timeout: 60000,
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` }
    });
    if (stderr) console.log('openclaw stderr:', stderr.slice(0, 500));
    console.log('openclaw stdout (first 300):', stdout.slice(0, 300));
    const parsed = JSON.parse(stdout);
    const payloads = parsed?.result?.payloads || parsed?.payloads || [];
    const text = payloads[0]?.text
      || payloads[0]?.content
      || (typeof parsed?.result === 'string' ? parsed.result : null)
      || (typeof parsed?.text === 'string' ? parsed.text : null)
      || null;
    if (!text) {
      console.error('Empty AI response, full JSON:', JSON.stringify(parsed, null, 2).slice(0, 2000));
      return res.status(502).json({ ok: false, error: 'AI agent returned no pricing result (empty payloads)' });
    }

    const durationMs = Date.now() - startTime;
    const logEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      ip: req.headers['x-forwarded-for'] || req.ip,
      brand, model, cpu, ram, storage, grade: condition, keyboard, quantity,
      price: text,
      duration_ms: durationMs
    }) + '\n';
    fs.appendFile(LOG_PATH, logEntry, (err) => {
      if (err) console.error('Failed to write request log:', err.message);
    });

    res.json({ ok: true, result: text });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(503).json({ ok: false, error: `openclaw not found. Set OPENCLAW_PATH.` });
    res.status(err.killed ? 504 : 500).json({ ok: false, error: err.message });
  }
});

// --- Request log viewer API ---
app.get('/api/requests-log', (req, res) => {
  try {
    if (!fs.existsSync(LOG_PATH)) return res.json([]);
    const raw = fs.readFileSync(LOG_PATH, 'utf8').trim();
    if (!raw) return res.json([]);
    const entries = raw.split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).filter(e => {
      // Only entries where price contains €
      return typeof e.price === 'string' && e.price.includes('€');
    }).map(e => {
      // Extract ERP per unit price number from price text
      let erpPrice = null;
      const m = e.price.match(/ERP\s+per\s+unit[:\s]*€\s*([\d.,]+)/i)
        || e.price.match(/per\s+unit[:\s]*€\s*([\d.,]+)/i)
        || e.price.match(/€\s*([\d.,]+)\s*\/?\s*(?:per\s+)?unit/i)
        || e.price.match(/€\s*([\d.,]+)/);
      if (m) erpPrice = parseFloat(m[1].replace(',', '.'));
      return {
        timestamp: e.timestamp,
        brand: e.brand || '',
        model: e.model || '',
        cpu: e.cpu || '',
        ram: e.ram || '',
        storage: e.storage || '',
        grade: e.grade || '',
        keyboard: e.keyboard || '',
        quantity: e.quantity || '',
        price: erpPrice,
        duration_ms: e.duration_ms || 0
      };
    });
    // Return newest first
    res.json(entries.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/feedback', (req, res) => {
  try {
    const line = JSON.stringify(req.body) + '\n';
    fs.appendFileSync(path.join(__dirname, '..', 'feedback.jsonl'), line);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`QuickQuote running on http://localhost:${PORT}`));
