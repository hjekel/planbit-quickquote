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

    const sessionId = `quickquote-${Date.now()}`;
    const args = ['agent', '--agent', 'main', '--session-id', sessionId, '-m', `Price this device: ${specs}`, '--json', '--thinking', 'medium'];
    const { stdout } = await execFileAsync(OPENCLAW_BIN, args, {
      timeout: 60000,
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` }
    });
    const parsed = JSON.parse(stdout);
    // Extract text from openclaw response – try multiple paths
    const payloads = parsed?.result?.payloads || parsed?.payloads || [];
    const text = payloads[0]?.text
      || payloads[0]?.content
      || (typeof parsed?.result === 'string' ? parsed.result : null)
      || (typeof parsed?.text === 'string' ? parsed.text : null)
      || null;
    if (!text) {
      console.error('Empty AI response:', JSON.stringify(parsed).slice(0, 500));
      return res.status(502).json({ ok: false, error: 'AI agent returned no pricing result (empty payloads)' });
    }

    // Log successful request
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

    // Strip verbose reasoning — only show final pricing report
    let cleanText = text;
    const reportIdx = text.indexOf('ERPIE PRICING REPORT');
    if (reportIdx >= 0) {
      // Find the separator line (━━━) before the header
      let start = reportIdx;
      const before = text.slice(0, reportIdx);
      const lastNewline = before.lastIndexOf('\n');
      if (lastNewline >= 0) {
        const lineAbove = before.slice(before.lastIndexOf('\n', lastNewline - 1) + 1, lastNewline).trim();
        if (/^[━─═]{3,}$/.test(lineAbove)) {
          start = before.lastIndexOf('\n', lastNewline - 1) + 1;
        } else {
          start = lastNewline + 1;
        }
      }
      cleanText = text.slice(start).trim();
    } else {
      // No report header — take last 15 lines
      const lines = text.split('\n');
      cleanText = lines.slice(-15).join('\n').trim();
    }

    res.json({ ok: true, result: cleanText });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(503).json({ ok: false, error: `openclaw not found. Set OPENCLAW_PATH.` });
    res.status(err.killed ? 504 : 500).json({ ok: false, error: err.message });
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
