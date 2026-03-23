'use strict';
const express = require('express');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const app = express();
const OPENCLAW_BIN = process.env.OPENCLAW_PATH || 'openclaw';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/public')));

app.post('/api/ai-quote', async (req, res) => {
  try {
    const { brand, model, cpu, ram, storage, condition, keyboard, region, battery, quantity } = req.body;
    const specs = [brand, model, cpu, ram, storage, condition, keyboard && 'Keyboard: ' + keyboard, region && 'Region: ' + region, battery && 'Battery: ' + battery, quantity && 'Quantity: ' + quantity].filter(Boolean).join(', ');
    if (!specs) return res.status(400).json({ ok: false, error: 'No device specs provided' });

    const args = ['agent', '--agent', 'main', '-m', `Price this device: ${specs}`, '--json'];
    const { stdout } = await execFileAsync(OPENCLAW_BIN, args, {
      timeout: 60000,
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` }
    });
    const parsed = JSON.parse(stdout);
    const text = parsed.result?.payloads?.[0]?.text || parsed.result?.text || (typeof parsed.result === 'string' ? parsed.result : null) || parsed.text || parsed.output;
    if (!text) return res.status(502).json({ ok: false, error: 'No pricing result from AI agent' });
    res.json({ ok: true, result: text });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(503).json({ ok: false, error: `openclaw not found. Set OPENCLAW_PATH.` });
    res.status(err.killed ? 504 : 500).json({ ok: false, error: err.message });
  }
});

app.listen(3002, () => console.log('QuickQuote running on http://localhost:3002'));
