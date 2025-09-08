// sniper-worker.js
// Phase-1 worker: Solana scanner + filters + Telegram alerts + simple API (health + stats)
// Alert-only by default. Auto-buy disabled.

const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();
const RPC_URL = 'https://flashy-aged-resonance.solana-mainnet.quiknode.pro/56802796f2acaa8919808e6762e69be13ddd5400/';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '5000', 10); // default 5s
const DEV_LOOKBACK_LIMIT = parseInt(process.env.DEV_LOOKBACK_LIMIT || '150', 10);
const MIN_LIQ_SOL = parseFloat(process.env.MIN_LIQ_SOL || '3'); // min liquidity
const MIN_HOLDERS = parseInt(process.env.MIN_HOLDERS || '20', 10);
const TOP10_LIMIT_PCT = parseFloat(process.env.TOP10_LIMIT_PCT || '20'); // top10 > this% -> ignore
const DEV_HOLDING_LIMIT_PCT = parseFloat(process.env.DEV_HOLDING_LIMIT_PCT || '5'); // dev holding > this% -> dev-in
const AI_KEYWORDS = (process.env.AI_KEYWORDS || 'AI,GPT,LLM,GenAI,Neural,Model,Agent').split(',');
const PORT = parseInt(process.env.PORT || '7000', 10);

const connection = new Connection(RPC_URL, 'confirmed');
const bot = TELEGRAM_TOKEN ? new TelegramBot(TELEGRAM_TOKEN) : null;

const app = express();
app.use(cors());
app.use(bodyParser.json());

const SPL_TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// simple stats store (in-memory + persist to file)
const STATS_FILE = path.join(__dirname, 'worker-stats.json');
let stats = {
  scanned: 0,
  alerts: [],
  wins: 0,
  losses: 0,
  scannerOn: true,
  lastError: null
};
try {
  if (fs.existsSync(STATS_FILE)) stats = JSON.parse(fs.readFileSync(STATS_FILE));
} catch (e) { /* ignore */ }
function saveStats() { try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); } catch (e){ } }

// helper: send Telegram message (HTML)
async function sendTelegram(msg) {
  console.log('[TG]', msg.replace(/<[^>]*>/g, ''));
  stats.alerts.unshift(new Date().toISOString() + ' | ' + msg.replace(/<[^>]*>/g, ''));
  while (stats.alerts.length > 200) stats.alerts.pop();
  saveStats();
  if (bot && TELEGRAM_CHAT_ID) {
    try {
      await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('Telegram send error', e.message || e);
    }
  }
}

// small API endpoints for UI
app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));
app.get('/api/stats', (req, res) => res.json(stats));
app.post('/api/mark', (req, res) => {
  const r = req.body && req.body.result;
  if (r === 'win') stats.wins++;
  else if (r === 'lose') stats.losses++;
  saveStats();
  res.json({ ok: true, stats });
});

// Utilities
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function containsAIKeyword(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return AI_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
}
async function getTopHolders(mint) {
  try {
    const largest = await connection.getTokenLargestAccounts(new PublicKey(mint));
    return largest.value || [];
  } catch (err) {
    return [];
  }
}
async function getMintInfo(mint) {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    if (info && info.value && info.value.data && info.value.data.parsed) {
      return info.value.data.parsed.info;
    }
  } catch (e) {}
  return null;
}

// Dev activity checker (lightweight)
async function checkDevActivity({ tokenMintStr, devAddrStr, lookbackLimit = DEV_LOOKBACK_LIMIT }) {
  try {
    const tokenMint = new PublicKey(tokenMintStr);
    const devPub = new PublicKey(devAddrStr);

    // try total supply
    let totalSupply = null;
    try {
      const mintInfo = await connection.getParsedAccountInfo(tokenMint);
      if (mintInfo && mintInfo.value && mintInfo.value.data && mintInfo.value.data.parsed) {
        totalSupply = parseFloat(mintInfo.value.data.parsed.info.supply || null);
      }
    } catch (e) {}

    // dev balance
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(devPub, { mint: tokenMint }).catch(()=>({ value: [] }));
    let devBalance = 0;
    for (const acc of (tokenAccounts.value || [])) {
      const ui = acc.account.data.parsed.info.tokenAmount.uiAmount || 0;
      devBalance += ui;
    }

    // quick top holders pct (we will compute in caller too)
    const sigs = await connection.getSignaturesForAddress(devPub, { limit: lookbackLimit });
    let totalMoved = 0;
    for (const s of sigs) {
      const parsed = await connection.getParsedTransaction(s.signature, 'confirmed').catch(()=>null);
      if (!parsed || !parsed.meta) continue;
      const inner = parsed.meta.innerInstructions || [];
      for (const block of inner) {
        for (const inst of block.instructions || []) {
          try {
            if (inst.program === 'spl-token' && inst.parsed && (inst.parsed.type === 'transfer' || inst.parsed.type === 'transferChecked')) {
              const info = inst.parsed.info;
              const src = info.source;
              const amtUi = info.tokenAmount ? parseFloat(info.tokenAmount.uiAmount || 0) : parseFloat(info.amount || 0);
              const srcInfo = await connection.getParsedAccountInfo(new PublicKey(src)).catch(()=>null);
              const srcMint = srcInfo && srcInfo.value && srcInfo.value.data && srcInfo.value.data.parsed ? srcInfo.value.data.parsed.info.mint : null;
              const srcOwner = srcInfo && srcInfo.value && srcInfo.value.data && srcInfo.value.data.parsed ? srcInfo.value.data.parsed.info.owner : null;
              if (srcMint === tokenMintStr && srcOwner === devAddrStr) {
                totalMoved += amtUi;
              }
            }
          } catch(e){}
        }
      }
    }
    const movedPct = (totalSupply && totalSupply>0) ? (totalMoved / totalSupply) * 100 : null;
    return { ok:true, devBalance, totalMoved, movedPct };
  } catch (err) {
    return { ok:false, error: (err.message||String(err)) };
  }
}

const seenMints = new Set();

// Main scanner (balanced, safe defaults)
async function scanLoop() {
  console.log('Scanner started. Interval ms:', CHECK_INTERVAL_MS);
  stats.scannerOn = true; saveStats();
  while (true) {
    try {
      // Pull last signatures from SPL token program (fast snapshot approach)
      const sigs = await connection.getSignaturesForAddress(SPL_TOKEN_PROGRAM, { limit: 40 });
      for (const s of sigs) {
        if (!s.signature) continue;
        const parsed = await connection.getParsedTransaction(s.signature, 'confirmed').catch(()=>null);
        if (!parsed || !parsed.transaction) continue;
        const msg = parsed.transaction.message;
        // look for initializeMint instruction (new token mint)
        for (const inst of msg.instructions || []) {
          try {
            const parsedInst = inst.parsed;
            if (!parsedInst) continue;
            if (parsedInst.type === 'initializeMint' && parsedInst.info && parsedInst.info.mint) {
              const mint = parsedInst.info.mint;
              if (seenMints.has(mint)) continue;
              seenMints.add(mint);
              stats.scanned++;
              saveStats();
              console.log('Found new mint:', mint);

              // quick top holders
              const top = await getTopHolders(mint);
              const topHolder = top && top[0] && top[0].address ? top[0].address : null;
              const topSum = top && top.slice(0,10).reduce((a,b)=>a + (b.uiAmount||0), 0);

              // get mint info
              const mintInfo = await getMintInfo(mint);
              const supply = mintInfo && mintInfo.supply ? parseFloat(mintInfo.supply) : null;

              // compute top10 pct if possible
              const top10Pct = (supply && topSum) ? (topSum / supply) * 100 : null;

              // candidate dev check
              let devFlag = 'UNKNOWN';
              let devMoved = 0;
              let devMovedPct = null;
              if (topHolder) {
                const devCheck = await checkDevActivity({ tokenMintStr: mint, devAddrStr: topHolder });
                if (devCheck.ok) {
                  devMoved = devCheck.totalMoved || 0;
                  devMovedPct = devCheck.movedPct;
                  const devBalance = devCheck.devBalance || 0;
                  // compute dev pct if we have supply
                  const devPct = (supply && devBalance) ? (devBalance / supply) * 100 : null;
                  if (devPct !== null && devPct > DEV_HOLDING_LIMIT_PCT) devFlag = 'DEV_IN';
                  else devFlag = 'DEV_OUT';
                }
              }

              // holders count estimate (top list length isn't full owners but it's rough)
              const holdersCount = top && top.length ? Math.max(top.length, MIN_HOLDERS) : MIN_HOLDERS;

              // basic liquidity heuristic: try to find token accounts with SOL liquidity - rough placeholder
              // For phase1 we rely on min holders & top10 checks and leave advanced LP parse for Phase2

              // AI narrative detection (keyword check)
              const nameSymbol = (mintInfo && (mintInfo.name || mintInfo.symbol)) ? ((mintInfo.name||'') + ' ' + (mintInfo.symbol||'')) : '';
              const aiTag = containsAIKeyword(nameSymbol) ? 'AI_WARM' : 'AI_NONE';

              // Risk scoring simple formula
              let risk = 50;
              if (devFlag === 'DEV_IN') risk += 30;
              if (top10Pct !== null && top10Pct > TOP10_LIMIT_PCT) risk += 20;
              if (holdersCount < MIN_HOLDERS) risk += 15;
              if (aiTag === 'AI_WARM') risk += 10;
              risk = Math.max(1, Math.min(99, risk)); // 1..99

              // Decision rules: apply your filters (dev-out default, top10 limit)
              const hideIfDevIn = true; // global default
              const hideIfTop10Big = true;
              let show = true;
              let reason = '';
              if (devFlag === 'DEV_IN' && hideIfDevIn) { show = false; reason = 'dev_in'; }
              if (top10Pct !== null && top10Pct > TOP10_LIMIT_PCT && hideIfTop10Big) { show = false; reason = 'top10_concentration'; }

              // Build alert message if show === true
              if (show) {
                const msg = `<b>New Token Detected</b>\nMint: <code>${mint}</code>\nDev: ${devFlag} (moved: ${devMoved || 0} ${devMovedPct ? '(' + devMovedPct.toFixed(3) + '%)' : ''})\nTop10%: ${top10Pct!==null?top10Pct.toFixed(3)+'%':'n/a'}\nHolders(estimate): ${holdersCount}\nRisk: ${risk}%\nNarrative: ${aiTag}\n\nCopy contract: ${mint}`;
                await sendTelegram(msg);
              } else {
                // store ignored alert for admin review
                stats.alerts.unshift(new Date().toISOString() + ' | IGNORED ' + mint + ' reason=' + reason);
                if (stats.alerts.length > 200) stats.alerts.pop();
                saveStats();
              }
            }
          } catch (e) {
            // ignore instruction parse errors
          }
        }
      }
    } catch (err) {
      console.error('scanLoop error', err.message || err);
      stats.lastError = err.message || String(err);
      saveStats();
      try { await sendTelegram(`<b>Scanner error</b>: ${err.message || String(err)}`); } catch(e){}
    }
    await sleep(CHECK_INTERVAL_MS);
  }
}

// start express + scanner
app.listen(PORT, () => {
  console.log(`Worker API listening at http://0.0.0.0:${PORT}`);
});
(async ()=> {
  console.log('Starting scanner worker...');
  await sendTelegram('<b>Sniper worker started (Phase1)</b>');
  scanLoop();
})();
