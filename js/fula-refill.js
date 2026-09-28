/*
 * FulaRefill — shared "Refill" helper for the FULA web pages (staking, VIP staking, bridge).
 *
 * When a claim or a bridge release cannot be paid because the CONTRACT (not the user) is short of
 * FULA, the fix is permissionless: anyone can call FulaRefillTreasury.refill(poolId) and the treasury
 * tops the pool back up to 1.1x its threshold (once per pool per 24h, while the treasury has funds).
 * This module (a) recognises that kind of revert, (b) reads why a refill is or is not possible right
 * now, and (c) renders a button that sends the refill from the connected wallet.
 *
 * Plain script, no build step. Works with the page's global `Web3` in BOTH web3 1.8.x (fula-staking)
 * and 4.x (VIP staking, bridge). Keep this file byte-identical between fulawebsite/js and
 * fxwebsite/js (the staking pages are duplicated there).
 *
 * Treasury source: fula-chain/contracts/core/FulaRefillTreasury.sol; addresses from
 * fula-chain/docs/refill-treasury/02-design-and-runbook.md.
 */
(function (global) {
  'use strict';

  var TREASURIES = {
    1: '0xb2A51311aAC9aDAe8F9785129c988539b1510c2d',
    8453: '0x78B54b8F2A6DbeC2A7Cf252DEc5C56E51D2A43E8',
    2046399126: '0xb821C2023cf7DB5a9D7CF3703aEaCB1395F800Af'
  };
  var TOKENS = {
    1: '0x92217cCaEDBdbc54C76c15feA18823db1558fDc9',
    8453: '0x9e12735d77c72c5C3670636D428f2F3815d8A4cB',
    2046399126: '0x9e12735d77c72c5C3670636D428f2F3815d8A4cB'
  };
  var NATIVE = { 1: 'ETH', 8453: 'ETH', 2046399126: 'sFUEL' };
  var MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
  var ONE = 1000000000000000000n;

  var TREASURY_ABI = [
    { "inputs": [{ "name": "account", "type": "address" }], "name": "isPool", "outputs": [{ "name": "", "type": "bool" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "name": "account", "type": "address" }], "name": "poolIdOf", "outputs": [{ "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "name": "poolId", "type": "uint256" }], "name": "getPool", "outputs": [{ "components": [{ "name": "account", "type": "address" }, { "name": "lastRefill", "type": "uint64" }, { "name": "enabled", "type": "bool" }, { "name": "threshold", "type": "uint256" }, { "name": "maxThreshold", "type": "uint256" }], "name": "", "type": "tuple" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "name": "poolId", "type": "uint256" }], "name": "previewRefill", "outputs": [{ "name": "amount", "type": "uint256" }], "stateMutability": "view", "type": "function" },
    { "inputs": [], "name": "paused", "outputs": [{ "name": "", "type": "bool" }], "stateMutability": "view", "type": "function" },
    { "inputs": [], "name": "treasuryBalance", "outputs": [{ "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
    { "inputs": [], "name": "cooldown", "outputs": [{ "name": "", "type": "uint64" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "name": "poolId", "type": "uint256" }], "name": "refill", "outputs": [{ "name": "amount", "type": "uint256" }], "stateMutability": "nonpayable", "type": "function" }
  ];
  var TOKEN_BALANCE_ABI = { "inputs": [{ "name": "account", "type": "address" }], "name": "balanceOf", "outputs": [{ "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" };
  var MULTICALL3_ABI = [{ "inputs": [{ "components": [{ "name": "target", "type": "address" }, { "name": "allowFailure", "type": "bool" }, { "name": "callData", "type": "bytes" }], "name": "calls", "type": "tuple[]" }], "name": "aggregate3", "outputs": [{ "components": [{ "name": "success", "type": "bool" }, { "name": "returnData", "type": "bytes" }], "name": "returnData", "type": "tuple[]" }], "stateMutability": "view", "type": "function" }];

  // Reverts that mean "the CONTRACT is short of FULA". `kind` says whether a refill can fix it:
  //   pool          the tokens come from a FulaRefillTreasury pool -> Refill button
  //   stake         a stake pool (user principal) is short -> never refillable, association
  //   distribution  TokenDistributionEngine / AirdropContract -> not a pool, association
  //   wallet        the USER's own balance is short (ERC20InsufficientBalance for the sender)
  var LOW_BALANCE_SIGS = [
    { sig: 'InsufficientRewardsInPool()', kind: 'pool', types: [] },                                  // StakingEngineLinear / SELWM claims
    { sig: 'InsufficientRewards()', kind: 'pool', types: [] },                                        // RewardEngine claims (mining)
    { sig: 'InsufficientLiquidity(uint256,uint256)', kind: 'pool', types: ['uint256', 'uint256'] },   // FulaOFTAdapter release on the receiving chain
    { sig: 'ERC20InsufficientBalance(address,uint256,uint256)', kind: 'erc20', types: ['address', 'uint256', 'uint256'] }, // OZ 5 token: pool if `from` is the contract
    { sig: 'InsufficientBalance(uint256,uint256)', kind: 'stake', types: ['uint256', 'uint256'] },    // StakingPool (principal) — not refillable
    { sig: 'LowContractBalance(uint256,uint256)', kind: 'distribution', types: ['uint256', 'uint256'] } // Distribution / Airdrop — not pools
  ];
  var TREASURY_ERRORS = [
    'PoolDisabled(uint256)', 'NotBelowThreshold(uint256,uint256,uint256)', 'CooldownActive(uint256,uint256)',
    'TreasuryEmpty()', 'EnforcedPause()', 'UnknownPool(uint256)', 'ZeroAmount()', 'OwnableUnauthorizedAccount(address)'
  ];

  function utils() { return (global.Web3 && global.Web3.utils) || null; }
  function selector(sig) { return utils().keccak256(sig).slice(0, 10); }
  function big(x) { try { return BigInt(String(x)); } catch (e) { return null; } }
  function sameAddr(a, b) { return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase(); }

  // BigInt wei -> "1,234.56" (never via Number for the integer part).
  function formatFula(wei, dp) {
    if (wei === null || wei === undefined) return '—';
    if (dp === undefined) dp = 2;
    var neg = wei < 0n; var a = neg ? -wei : wei;
    var whole = a / ONE, frac = a % ONE;
    var s = whole.toLocaleString('en-US');
    if (dp > 0 && frac > 0n) {
      var fs = (ONE + frac).toString().slice(1, 1 + dp).replace(/0+$/, '');
      if (fs) s += '.' + fs;
    }
    return (neg ? '-' : '') + s;
  }

  // ---------------------------------------------------------------- revert detection
  // Where revert data hides, by library and provider:
  //   web3 4.x + HTTP read RPC ........ err.cause.data (ContractExecutionError); raw eth.call/estimateGas: err.data / err.innerError.data
  //   web3 4.x + wallet (EIP-1193) .... err.data.data / err.data.originalError.data / err.jsonRpcError.data / err.innerError.data
  //   web3 1.8 + HTTP read RPC ........ err.data (string)
  //   web3 1.8 + wallet ............... ONLY inside err.message (the library stringifies the RPC error object)
  //   ethers-style objects ............ err.data, err.info.error.data, err.error.data
  function findRevertHex(err) {
    if (!err) return null;
    var seen = [];
    var cands = [];
    var push = function (x) { if (x !== undefined && x !== null) cands.push(x); };
    push(err.cause && err.cause.data); push(err.data); push(err.jsonRpcError && err.jsonRpcError.data);
    push(err.innerError && err.innerError.data); push(err.info && err.info.error && err.info.error.data);
    push(err.error && err.error.data); push(err.cause);
    for (var i = 0; i < cands.length; i++) {
      var x = cands[i];
      for (var depth = 0; depth < 4 && x && typeof x === 'object'; depth++) {
        if (seen.indexOf(x) >= 0) break; seen.push(x);
        x = (x.originalError && x.originalError.data) || x.data || x.cause || null;
      }
      if (typeof x === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(x)) return x;
    }
    var m = String((err && err.message) || err).match(/0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{2})*/g);
    if (m) for (var k = 0; k < m.length; k++) { if (m[k].length >= 10 && m[k].length !== 42 && m[k].length !== 66) return m[k]; }
    return null;
  }

  function decodeArgs(web3, types, hex) {
    if (!types.length) return [];
    try { var d = web3.eth.abi.decodeParameters(types, '0x' + hex.slice(10)); var out = []; for (var i = 0; i < types.length; i++) out.push(d[i]); return out; }
    catch (e) { return []; }
  }

  /**
   * Classify an error. ctx.contract = the contract the user was calling (to tell "the contract is
   * short" from "the user is short" for OZ's ERC20InsufficientBalance). ctx.web3 = any web3 instance
   * for ABI decoding (optional; falls back to a throwaway one).
   * Returns { kind: 'pool'|'stake'|'distribution'|'wallet'|null, name, selector, args, text, hex }
   */
  function detectLowBalance(err, ctx) {
    ctx = ctx || {};
    var web3 = ctx.web3 || (global.Web3 ? new global.Web3() : null);
    var hex = findRevertHex(err);
    var text = String((err && err.message) || err || '');
    var out = { kind: null, name: null, selector: hex ? hex.slice(0, 10) : null, args: [], text: text, hex: hex };
    if (hex && web3) {
      var sel = hex.slice(0, 10).toLowerCase();
      if (sel === '0x08c379a0') { // Error(string)
        var s = decodeArgs(web3, ['string'], hex)[0] || '';
        out.name = 'Error'; out.args = [s]; out.text = s;
        if (/insufficient rewards in pool/i.test(s)) out.kind = 'pool';
        else if (/insufficient (liquidity|rewards)/i.test(s)) out.kind = 'pool';
        return out;
      }
      for (var i = 0; i < LOW_BALANCE_SIGS.length; i++) {
        var e = LOW_BALANCE_SIGS[i];
        if (selector(e.sig).toLowerCase() !== sel) continue;
        out.name = e.sig.slice(0, e.sig.indexOf('(')); out.args = decodeArgs(web3, e.types, hex);
        if (e.kind === 'erc20') out.kind = (ctx.contract && out.args[0] && sameAddr(out.args[0], ctx.contract)) ? 'pool' : (ctx.contract ? 'wallet' : 'pool');
        else out.kind = e.kind;
        return out;
      }
      for (var t = 0; t < TREASURY_ERRORS.length; t++) {
        if (selector(TREASURY_ERRORS[t]).toLowerCase() === sel) { out.name = TREASURY_ERRORS[t].slice(0, TREASURY_ERRORS[t].indexOf('(')); return out; }
      }
      return out;
    }
    // No data (some RPCs strip it): fall back to text.
    if (/insufficient rewards in pool|InsufficientRewardsInPool|InsufficientRewards\b|InsufficientLiquidity/i.test(text)) out.kind = 'pool';
    else if (/LowContractBalance/i.test(text)) out.kind = 'distribution';
    return out;
  }

  // ---------------------------------------------------------------- status
  function treasuryFor(chainId) { return TREASURIES[Number(chainId)] || null; }
  function tokenFor(chainId) { return TOKENS[Number(chainId)] || null; }

  function enc(web3, abiItem, params) { return web3.eth.abi.encodeFunctionCall(abiItem, params || []); }
  function abiItem(name) { for (var i = 0; i < TREASURY_ABI.length; i++) if (TREASURY_ABI[i].name === name) return TREASURY_ABI[i]; return null; }
  function mcItem(item) {
    var ok = (item && item.success !== undefined) ? item.success : (item ? item[0] : false);
    var data = (item && item.returnData !== undefined) ? item.returnData : (item ? item[1] : null);
    return { ok: (ok === true || ok === 'true'), data: (data && data !== '0x') ? data : null };
  }
  function dec(web3, types, data) { try { var d = web3.eth.abi.decodeParameters(types, data); return d; } catch (e) { return null; } }

  /**
   * Read everything the button needs in ONE Multicall3 call.
   * Returns { chainId, treasury, token, isPool, poolId, enabled, threshold, poolBalance, preview,
   *           paused, treasuryBalance, cooldown, lastRefill, availableAt, reason }
   * reason: 'no-treasury' | 'not-pool' | 'paused' | 'disabled' | 'not-below-threshold' | 'cooldown' | 'treasury-empty' | 'ok' | 'unreadable'
   */
  function status(web3, chainId, poolAddress) {
    var treasury = treasuryFor(chainId), token = tokenFor(chainId);
    var res = { chainId: Number(chainId), treasury: treasury, token: token, isPool: false, poolId: null, enabled: null, threshold: null, poolBalance: null, preview: null, paused: null, treasuryBalance: null, cooldown: null, lastRefill: null, availableAt: null, reason: 'no-treasury' };
    if (!treasury || !token || !poolAddress) return Promise.resolve(res);
    var mc = new web3.eth.Contract(MULTICALL3_ABI, MULTICALL3);
    var calls = [
      [treasury, true, enc(web3, abiItem('isPool'), [poolAddress])],
      [treasury, true, enc(web3, abiItem('poolIdOf'), [poolAddress])],
      [treasury, true, enc(web3, abiItem('paused'), [])],
      [treasury, true, enc(web3, abiItem('treasuryBalance'), [])],
      [treasury, true, enc(web3, abiItem('cooldown'), [])],
      [token, true, enc(web3, TOKEN_BALANCE_ABI, [poolAddress])]
    ];
    return mc.methods.aggregate3(calls).call().then(function (r) {
      var isPool = mcItem(r[0]), poolId = mcItem(r[1]), paused = mcItem(r[2]), tb = mcItem(r[3]), cd = mcItem(r[4]), bal = mcItem(r[5]);
      if (!isPool.ok || !isPool.data) { res.reason = 'unreadable'; return res; }
      res.isPool = !!(dec(web3, ['bool'], isPool.data) || {})[0];
      if (paused.ok && paused.data) res.paused = !!(dec(web3, ['bool'], paused.data) || {})[0];
      if (tb.ok && tb.data) res.treasuryBalance = big((dec(web3, ['uint256'], tb.data) || {})[0]);
      if (cd.ok && cd.data) res.cooldown = Number((dec(web3, ['uint64'], cd.data) || {})[0]);
      if (bal.ok && bal.data) res.poolBalance = big((dec(web3, ['uint256'], bal.data) || {})[0]);
      if (!res.isPool) { res.reason = 'not-pool'; return res; }
      res.poolId = Number((dec(web3, ['uint256'], poolId.data) || {})[0]);
      // second round: pool struct + preview (need the id)
      var calls2 = [
        [treasury, true, enc(web3, abiItem('getPool'), [res.poolId])],
        [treasury, true, enc(web3, abiItem('previewRefill'), [res.poolId])]
      ];
      return mc.methods.aggregate3(calls2).call().then(function (r2) {
        var gp = mcItem(r2[0]), pv = mcItem(r2[1]);
        if (gp.ok && gp.data) {
          // Pool is a static struct (no dynamic members): ABI-encoded as five inline words.
          var d = dec(web3, ['address', 'uint64', 'bool', 'uint256', 'uint256'], gp.data);
          if (d) {
            res.lastRefill = Number(d[1]);
            res.enabled = !!d[2];
            res.threshold = big(d[3]);
          }
        }
        if (pv.ok && pv.data) res.preview = big((dec(web3, ['uint256'], pv.data) || {})[0]);
        var now = Math.floor(Date.now() / 1000);
        if (res.lastRefill !== null && res.cooldown !== null) res.availableAt = res.lastRefill + res.cooldown;
        if (res.paused) res.reason = 'paused';
        else if (res.enabled === false) res.reason = 'disabled';
        else if (res.threshold !== null && res.poolBalance !== null && res.poolBalance >= res.threshold) res.reason = 'not-below-threshold';
        else if (res.availableAt !== null && res.availableAt > now) res.reason = 'cooldown';
        else if (res.treasuryBalance !== null && res.treasuryBalance === 0n) res.reason = 'treasury-empty';
        else if (res.preview !== null && res.preview > 0n) res.reason = 'ok';
        else res.reason = (res.preview === null) ? 'unreadable' : 'not-below-threshold';
        return res;
      });
    }).catch(function () { res.reason = 'unreadable'; return res; });
  }

  // ---------------------------------------------------------------- pre-flight
  /**
   * Gas estimate that KEEPS reverts. `opts.estimate` runs eth_estimateGas on the CURRENT read RPC,
   * `opts.rotate` moves to the next RPC, `opts.attempts` how many. A revert (data present or
   * "revert" in the message) is thrown — so the caller can decode it and show Refill BEFORE the user
   * signs — while plain RPC flakiness falls back to `opts.fallback`. Mirrors governance.js estimateGas.
   */
  function preflight(opts) {
    var attempts = Math.max(1, opts.attempts || 1);
    var revert = null;
    var i = 0;
    function step() {
      if (i >= attempts) { if (revert) return Promise.reject(revert); return Promise.resolve(opts.fallback || 600000); }
      i++;
      return Promise.resolve().then(opts.estimate).then(function (g) {
        return Math.ceil(Number(g) * (opts.headroom || 1.4));
      }).catch(function (e) {
        var hasData = !!findRevertHex(e);
        if (hasData || /execution reverted|revert/i.test(String((e && e.message) || e))) { if (hasData || !revert) revert = e; }
        if (opts.rotate) { try { opts.rotate(); } catch (_) { /* ignore */ } }
        return step();
      });
    }
    return step();
  }

  // ---------------------------------------------------------------- copy
  function friendly(kind, ctx) {
    ctx = ctx || {};
    var what = ctx.what || 'this payout';
    switch (kind) {
      case 'pool': return 'The contract’s reward pool holds less FULA than ' + what + '. Nothing was sent. Anyone can top it up from the Fula refill treasury:';
      case 'stake': return 'The staking contract cannot pay out this stake right now (its principal pool is short). Nothing was sent. Please contact the Fula Governance Association.';
      case 'distribution': return 'This contract holds less FULA than ' + what + '. Nothing was sent. It is funded by the Fula Governance Association, not by the refill treasury — please contact them.';
      case 'wallet': return 'Your wallet does not hold enough FULA for this.';
      default: return null;
    }
  }
  function reasonText(st, needed) {
    var pre = st.preview !== null ? formatFula(st.preview) : '?';
    switch (st.reason) {
      case 'no-treasury': return 'No refill treasury on this network. Please contact the Fula Governance Association.';
      case 'not-pool': return 'This contract is not a refill-treasury pool; it needs funding by the Fula Governance Association.';
      case 'paused': return 'Refills are paused by the treasury guardian.';
      case 'disabled': return 'This pool is disabled in the refill treasury.';
      case 'not-below-threshold': return 'The pool is not below its refill threshold (' + formatFula(st.threshold) + ' FULA), so a refill would do nothing right now.';
      case 'cooldown': return 'This pool was refilled recently. Next refill available ' + (st.availableAt ? new Date(st.availableAt * 1000).toLocaleString() : 'later') + '.';
      case 'treasury-empty': return 'The refill treasury is empty — it needs governance funding before anyone can refill. Please contact the Fula Governance Association.';
      case 'unreadable': return 'Could not read the refill treasury right now. Try again shortly.';
      case 'ok': return (needed !== null && needed !== undefined && st.preview !== null && st.preview < needed)
        ? 'A refill sends +' + pre + ' FULA now (covers ' + pre + ' of the ' + formatFula(needed) + ' FULA needed).'
        : 'A refill sends +' + pre + ' FULA to the pool now.';
    }
    return '';
  }

  // ---------------------------------------------------------------- button
  /**
   * Render the refill control into `container`.
   * opts: { web3Read, chainId, poolAddress, needed (BigInt|null), from, getWalletWeb3 (async), feeParams (async -> tx fields),
   *         gasLimit (number, default 250000), onDone (fn), onNotify (fn(msg, type)), what (string) }
   */
  function renderButton(container, opts) {
    if (!container) return Promise.resolve(null);
    container.innerHTML = '<div class="fula-refill"><span class="fula-refill-text">Checking the refill treasury…</span></div>';
    var box = container.firstChild;
    var textEl = box.querySelector('.fula-refill-text');
    var notify = opts.onNotify || function () {};
    var native = NATIVE[Number(opts.chainId)] || 'gas';
    return status(opts.web3Read, opts.chainId, opts.poolAddress).then(function (st) {
      var explain = reasonText(st, opts.needed);
      textEl.textContent = explain;
      if (st.reason !== 'ok') { box.classList.add('fula-refill-' + st.reason); return st; }
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'fula-refill-btn';
      btn.textContent = 'Refill pool (+' + formatFula(st.preview) + ' FULA)';
      btn.title = 'Sends FulaRefillTreasury.refill(' + st.poolId + ') from your wallet. You only pay the ' + native + ' gas; the FULA comes from the treasury.';
      box.appendChild(btn);
      var hint = document.createElement('span'); hint.className = 'fula-refill-hint'; hint.textContent = ' (you pay only the ' + native + ' gas)';
      box.appendChild(hint);
      btn.addEventListener('click', function () {
        btn.disabled = true; btn.textContent = 'Checking…';
        var data = enc(opts.web3Read, abiItem('refill'), [st.poolId]);
        var from = opts.from;
        // Pre-simulate on the read RPC so a refill that would revert (cooldown, empty, token paused)
        // never reaches the wallet.
        return Promise.resolve().then(function () {
          return opts.web3Read.eth.estimateGas({ from: from, to: st.treasury, data: data });
        }).then(function (g) {
          btn.textContent = 'Confirm in wallet…';
          return opts.getWalletWeb3().then(function (w3) {
            return Promise.resolve(opts.feeParams ? opts.feeParams() : {}).then(function (fee) {
              var tx = { from: from, to: st.treasury, data: data, gas: Math.max(Math.ceil(Number(g) * 1.4), opts.gasLimit || 0) };
              for (var k in (fee || {})) if (Object.prototype.hasOwnProperty.call(fee, k)) tx[k] = fee[k];
              return w3.eth.sendTransaction(tx);
            });
          });
        }).then(function (receipt) {
          notify('Refill sent — the pool was topped up. Try your claim again.', 'success');
          btn.remove(); hint.remove();
          textEl.textContent = 'Refilled. Reloading…';
          if (opts.onDone) return opts.onDone(receipt);
        }).catch(function (e) {
          var low = detectLowBalance(e, { web3: opts.web3Read, contract: st.treasury });
          var msg;
          if (e && (e.code === 4001 || e.code === 'ACTION_REJECTED' || /reject|denied|cancell/i.test(String(e.message || '')))) msg = 'Refill cancelled.';
          else if (low.name === 'CooldownActive') msg = 'This pool was refilled moments ago (24h cooldown). Try your claim again — it may already be covered.';
          else if (low.name === 'NotBelowThreshold') msg = 'The pool is already above its threshold — someone refilled it. Try your claim again.';
          else if (low.name === 'TreasuryEmpty') msg = 'The refill treasury is empty. It needs governance funding.';
          else if (low.name === 'EnforcedPause') msg = 'Refills are paused by the treasury guardian.';
          else if (/insufficient funds/i.test(String(e && e.message || ''))) msg = 'Not enough ' + native + ' in your wallet to pay the gas for the refill.';
          else msg = 'Refill failed: ' + (low.name || String((e && e.message) || e)).slice(0, 160);
          notify(msg, 'error');
          btn.disabled = false; btn.textContent = 'Refill pool (+' + formatFula(st.preview) + ' FULA)';
          // refresh the explanation in case state moved under us
          return status(opts.web3Read, opts.chainId, opts.poolAddress).then(function (st2) { textEl.textContent = reasonText(st2, opts.needed); if (st2.reason !== 'ok') { btn.remove(); hint.remove(); } });
        });
      });
      return st;
    });
  }

  // Minimal styling, injected once (pages can override via .fula-refill*).
  function injectStyle() {
    if (document.getElementById('fula-refill-style')) return;
    var s = document.createElement('style'); s.id = 'fula-refill-style';
    s.textContent = '.fula-refill{margin-top:8px;font-size:13px;line-height:1.5;display:flex;flex-wrap:wrap;align-items:center;gap:8px}' +
      '.fula-refill-text{flex:1 1 100%}.fula-refill-hint{opacity:.7;font-size:12px}' +
      '.fula-refill-btn{padding:6px 12px;border:1px solid #00B894;background:#00D4AA;color:#0F0F1A;border-radius:8px;font-weight:600;cursor:pointer}' +
      '.fula-refill-btn:disabled{opacity:.6;cursor:default}' +
      '.fula-refill-treasury-empty .fula-refill-text,.fula-refill-not-pool .fula-refill-text,.fula-refill-no-treasury .fula-refill-text{color:#c77700}';
    (document.head || document.documentElement).appendChild(s);
  }
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectStyle); else injectStyle(); }

  global.FulaRefill = {
    VERSION: '1.0.0',
    TREASURIES: TREASURIES, TOKENS: TOKENS, TREASURY_ABI: TREASURY_ABI,
    treasuryFor: treasuryFor, tokenFor: tokenFor,
    detectLowBalance: detectLowBalance, findRevertHex: findRevertHex,
    status: status, preflight: preflight, renderButton: renderButton,
    friendly: friendly, reasonText: reasonText, formatFula: formatFula, selector: selector
  };
})(typeof window !== 'undefined' ? window : this);
