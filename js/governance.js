/* ==========================================================================
   Fula governance — CommunityVoting UI
   --------------------------------------------------------------------------
   Loaded as an ES module so it can import the Reown AppKit CDN bundle while
   still living in its own file. The other wallet pages inline ~90 KB of script
   in the HTML; this page is considerably more complex, so the logic lives here
   and the markup stays readable.

   Two things about this contract drive the whole design:

   1. Ballot option TEXT is not stored on-chain. Only keccak256 of each label
      is (`optionHashes`), because holding a dynamic string array per subject
      cost more bytecode than remained under the 24 KiB contract-size limit.
      The text lives in the SubjectOptions event, so labels are recovered from
      logs and then verified against the on-chain hashes. That turns a storage
      compromise into a visible integrity guarantee.

   2. Base RPCs serve stale reads and stale nonces for several seconds after a
      write, and some strip revert data entirely. Every read that follows a
      write polls, every send retries, and revert data is decoded manually.
      All three were hit repeatedly during the contract's testnet rehearsal.
   ========================================================================== */

import { WagmiAdapter, createAppKit, networks, WagmiCore } from 'https://cdn.jsdelivr.net/npm/@reown/appkit-cdn@1.8.20/dist/appkit.js';

(function () {
  'use strict';

  /* ── Config ───────────────────────────────────────────────────────────── */

  const CONFIG = {
    PROJECT_ID: '192a8f5e8d1742ea923be485e60f2612',
    VOTING: '0xD2ae210b415B6b7077DCEcCA680fFc3FE621542A',
    TOKEN: '0x9e12735d77c72c5C3670636D428f2F3815d8A4cB',
    // Block the voting proxy was deployed in. Log queries start here: public RPCs
    // reject a scan from block 0, and everything this page needs postdates it.
    DEPLOY_BLOCK: 50415014,
    CHAIN_ID: 8453,
    CHAIN_ID_HEX: '0x2105',
    CHAIN_NAME: 'Base',
    EXPLORER: 'https://basescan.org',
    // Public Base RPCs reject eth_getLogs ranges wider than ~10k blocks — measured, not assumed.
    LOG_CHUNK: 9000,
    // Base produces a block every 2 seconds, which is what makes a subject's creation
    // block predictable from its timestamp instead of searchable.
    BLOCK_TIME: 2
  };

  // Ordered best-first by tested burst tolerance, matching the other wallet pages.
  //
  // Log support varies sharply and is NOT correlated with how well an endpoint serves
  // ordinary calls. Measured on Base mainnet: publicnode answers eth_getLogs with 403
  // Forbidden outright, 1rpc and blastapi fail, drpc serves sparse contracts fine, and
  // mainnet.base.org and tenderly handle the widest ranges. The last two are what make
  // ballot-label recovery work, so both are in the pool; readLogs() rotates past the
  // rest automatically rather than trusting the first empty answer.
  const RPC_URLS = [
    'https://base-rpc.publicnode.com',
    'https://1rpc.io/base',
    'https://base-mainnet.public.blastapi.io',
    'https://base.drpc.org',
    'https://mainnet.base.org',
    'https://base.gateway.tenderly.co'
  ];
  const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
  const MULTICALL3_ABI = [{"inputs":[{"components":[{"name":"target","type":"address"},{"name":"allowFailure","type":"bool"},{"name":"callData","type":"bytes"}],"name":"calls","type":"tuple[]"}],"name":"aggregate3","outputs":[{"components":[{"name":"success","type":"bool"},{"name":"returnData","type":"bytes"}],"name":"returnData","type":"tuple[]"}],"stateMutability":"view","type":"function"}];

  const IPFS_GATEWAYS = [
    'https://ipfs.io/ipfs/',
    'https://dweb.link/ipfs/',
    'https://cloudflare-ipfs.com/ipfs/',
    'https://gateway.pinata.cloud/ipfs/'
  ];

  const SUBJECT_OUT = [
    {"name":"creator","type":"address"},{"name":"createdAt","type":"uint40"},{"name":"closeTime","type":"uint40"},
    {"name":"optionCount","type":"uint16"},{"name":"deposit","type":"uint96"},{"name":"voterCount","type":"uint32"},
    {"name":"winningOption","type":"uint16"},{"name":"status","type":"uint8"},{"name":"tied","type":"bool"},
    {"name":"depositRefundable","type":"bool"},{"name":"depositSettled","type":"bool"},
    {"name":"totalPowerCast","type":"uint128"},{"name":"totalBasis","type":"uint128"},
    {"name":"quorumBasisAt","type":"uint96"},{"name":"quorumVotersAt","type":"uint32"},
    {"name":"memberMultiplierBpsAt","type":"uint32"},{"name":"stakerMultiplierBpsAt","type":"uint32"},
    {"name":"stakeWeightBpsAt","type":"uint16"},{"name":"minVoteBasisAt","type":"uint96"},
    {"name":"minPoolJoinStakeAt","type":"uint96"},{"name":"title","type":"string"},{"name":"descriptionCID","type":"string"}
  ];
  const RECEIPT_OUT = [
    {"name":"lockedAmount","type":"uint128"},{"name":"power","type":"uint128"},{"name":"basis","type":"uint128"},
    {"name":"option","type":"uint16"},{"name":"voted","type":"bool"},{"name":"claimed","type":"bool"},
    {"name":"multiplierBps","type":"uint32"}
  ];
  const PROPOSAL_OUT = [
    {"name":"proposalType","type":"uint8"},{"name":"target","type":"address"},{"name":"id","type":"uint40"},
    {"name":"role","type":"bytes32"},{"name":"tokenAddress","type":"address"},{"name":"amount","type":"uint96"},
    {"components":[{"name":"expiryTime","type":"uint64"},{"name":"executionTime","type":"uint64"},{"name":"approvals","type":"uint16"},{"name":"status","type":"uint8"}],"name":"config","type":"tuple"}
  ];

  /**
   * web3.js requires every ABI input and output to carry a `name`. Without one its
   * encoder throws "Invalid parameters for method X: Cannot read properties of
   * undefined (reading 'replace')" on the very first call — which is what happened
   * here, and what an ethers-based check cannot catch because ethers does not care.
   *
   * The fragments below are written type-only so they stay readable, so the names are
   * filled in once, here, instead of being repeated fifty times by hand. Doing it in
   * code also means a fragment added later cannot reintroduce the fault.
   */
  function nameAbi(fragments) {
    const fill = (arr, prefix) => (arr || []).map((p, i) => ({
      ...p,
      name: p.name || prefix + i,
      ...(p.components ? { components: fill(p.components, prefix) } : {})
    }));
    return fragments.map(f => ({
      ...f,
      inputs: fill(f.inputs, 'a'),
      ...(f.outputs ? { outputs: fill(f.outputs, 'o') } : {})
    }));
  }

  const VOTING_ABI = nameAbi([
    {"inputs":[],"name":"subjectCount","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"uint256"}],"name":"getSubject","outputs":[{"components":SUBJECT_OUT,"type":"tuple"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"uint256"},{"type":"uint256"}],"name":"optionHashes","outputs":[{"type":"bytes32"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"uint256"},{"type":"uint16"}],"name":"tally","outputs":[{"type":"uint128"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"uint256"},{"type":"address"}],"name":"getReceipt","outputs":[{"components":RECEIPT_OUT,"type":"tuple"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"uint8"}],"name":"paramValue","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"uint8"}],"name":"paramBounds","outputs":[{"name":"minValue","type":"uint256"},{"name":"maxValue","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"token","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"stakingEngine","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"storagePool","outputs":[{"type":"address"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"paused","outputs":[{"type":"bool"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"bytes32"},{"type":"address"}],"name":"hasRole","outputs":[{"type":"bool"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"bytes32"}],"name":"roleConfigs","outputs":[{"name":"quorum","type":"uint16"},{"name":"transactionLimit","type":"uint240"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"address"}],"name":"timeConfigs","outputs":[{"name":"lastActivityTime","type":"uint64"},{"name":"roleChangeTimeLock","type":"uint64"},{"name":"whitelistLockTime","type":"uint64"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"address"}],"name":"lastCreateAt","outputs":[{"type":"uint40"}],"stateMutability":"view","type":"function"},
    {"inputs":[],"name":"proposalCount","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"uint256"}],"name":"proposalRegistry","outputs":[{"type":"bytes32"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"bytes32"}],"name":"proposals","outputs":PROPOSAL_OUT,"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"address"}],"name":"pendingProposals","outputs":[{"type":"uint8"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"bytes32"},{"type":"address"}],"name":"hasProposalApproval","outputs":[{"type":"bool"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"string"},{"type":"string"},{"type":"string[]"},{"type":"uint256"}],"name":"createSubject","outputs":[{"type":"uint256"}],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"type":"uint256"},{"type":"uint16"},{"type":"uint256"},{"type":"uint256[]"},{"type":"uint32"},{"type":"bytes32"}],"name":"vote","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"type":"uint256"}],"name":"claim","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"type":"uint256"}],"name":"claimDeposit","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"type":"uint256"}],"name":"finalize","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"type":"uint256"}],"name":"settleDeposit","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"type":"uint8"},{"type":"uint40"},{"type":"address"},{"type":"bytes32"},{"type":"uint96"},{"type":"address"}],"name":"createProposal","outputs":[{"type":"bytes32"}],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"type":"bytes32"}],"name":"approveProposal","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"type":"bytes32"}],"name":"executeProposal","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"type":"uint256"}],"name":"cleanupExpiredProposals","outputs":[],"stateMutability":"nonpayable","type":"function"},
    {"anonymous":false,"inputs":[{"indexed":true,"name":"subjectId","type":"uint256"},{"indexed":false,"name":"options","type":"string[]"}],"name":"SubjectOptions","type":"event"},
    // Custom errors, so revert data can be decoded into something a person can read.
    {"inputs":[],"name":"RecoveryBlocked","type":"error"},
    {"inputs":[{"type":"uint256"},{"type":"address"}],"name":"AlreadyVoted","type":"error"},
    {"inputs":[{"type":"uint256"},{"type":"uint256"}],"name":"BasisBelowMinimum","type":"error"},
    {"inputs":[{"type":"uint256"}],"name":"SubjectClosed","type":"error"},
    {"inputs":[{"type":"uint256"}],"name":"SubjectStillOpen","type":"error"},
    {"inputs":[{"type":"uint256"}],"name":"SubjectNotFound","type":"error"},
    {"inputs":[{"type":"uint256"}],"name":"AlreadyFinalized","type":"error"},
    {"inputs":[{"type":"uint40"}],"name":"CreateCooldownActive","type":"error"},
    {"inputs":[{"type":"uint256"}],"name":"TooManyOpenSubjects","type":"error"},
    {"inputs":[{"type":"uint256"}],"name":"StakeNotQualifying","type":"error"},
    {"inputs":[],"name":"StakeIndicesNotAscending","type":"error"},
    {"inputs":[],"name":"MembershipNotEligible","type":"error"},
    {"inputs":[],"name":"NothingToClaim","type":"error"},
    {"inputs":[],"name":"AlreadyClaimed","type":"error"},
    {"inputs":[],"name":"QuorumNotMet","type":"error"},
    {"inputs":[],"name":"DepositIsRefundable","type":"error"},
    {"inputs":[],"name":"DepositAlreadySettled","type":"error"},
    {"inputs":[],"name":"NotSubjectCreator","type":"error"},
    {"inputs":[{"type":"uint256"}],"name":"InvalidOptionCount","type":"error"},
    {"inputs":[{"type":"uint256"}],"name":"OptionEmpty","type":"error"},
    {"inputs":[{"type":"uint256"}],"name":"OptionTooLong","type":"error"},
    {"inputs":[{"type":"uint256"}],"name":"DuplicateOption","type":"error"},
    {"inputs":[],"name":"TitleTooLong","type":"error"},
    {"inputs":[],"name":"CidTooLong","type":"error"},
    {"inputs":[{"type":"uint256"}],"name":"InvalidDuration","type":"error"},
    {"inputs":[{"type":"uint8"},{"type":"uint256"}],"name":"ParamOutOfBounds","type":"error"},
    {"inputs":[{"type":"uint8"}],"name":"InvalidParam","type":"error"},
    {"inputs":[],"name":"NonCanonicalProposalField","type":"error"},
    {"inputs":[{"type":"uint8"}],"name":"IntegrationDisabled","type":"error"},
    {"inputs":[{"type":"address"}],"name":"ExistingActiveProposal","type":"error"},
    {"inputs":[{"type":"address"}],"name":"TimeLockActive","type":"error"},
    {"inputs":[],"name":"EnforcedPause","type":"error"},
    {"inputs":[{"type":"uint16"}],"name":"InvalidOption","type":"error"},
    {"inputs":[{"type":"uint256"}],"name":"TooManyStakeIndices","type":"error"},
    {"inputs":[{"type":"uint256"},{"type":"uint256"}],"name":"LowBalance","type":"error"},
    {"inputs":[{"type":"uint256"}],"name":"ExecutionDelayNotMet","type":"error"},
    {"inputs":[{"type":"uint16"},{"type":"uint16"}],"name":"InsufficientApprovals","type":"error"},
    {"inputs":[{"type":"uint8"}],"name":"ProposalErr","type":"error"},
    {"inputs":[{"type":"uint256"}],"name":"CoolDownActive","type":"error"},
    {"inputs":[{"type":"uint8"}],"name":"Failed","type":"error"},
    {"inputs":[],"name":"TransferRestricted","type":"error"},
    {"inputs":[{"type":"address"}],"name":"SafeERC20FailedOperation","type":"error"},
    {"inputs":[{"type":"address"},{"type":"bytes32"}],"name":"AccessControlUnauthorizedAccount","type":"error"},
    {"inputs":[],"name":"BalanceDecreased","type":"error"},
    {"inputs":[],"name":"AmountMustBePositive","type":"error"},
    {"inputs":[],"name":"InvalidAddress","type":"error"}
  ]);

  const TOKEN_ABI = nameAbi([
    {"inputs":[{"type":"address"}],"name":"balanceOf","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"address"},{"type":"address"}],"name":"allowance","outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"type":"address"},{"type":"uint256"}],"name":"approve","outputs":[{"type":"bool"}],"stateMutability":"nonpayable","type":"function"}
  ]);

  const STAKING_ABI = nameAbi([
    {"inputs":[{"type":"address"}],"name":"getUserStakes","outputs":[{"components":[
      {"name":"amount","type":"uint256"},{"name":"rewardDebt","type":"uint256"},{"name":"lockPeriod","type":"uint256"},
      {"name":"startTime","type":"uint256"},{"name":"referrer","type":"address"},{"name":"isActive","type":"bool"}
    ],"type":"tuple[]"}],"stateMutability":"view","type":"function"}
  ]);

  const ADMIN_ROLE = '0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775'; // keccak256("ADMIN_ROLE")
  const ZERO = '0x0000000000000000000000000000000000000000';
  const ZERO32 = '0x' + '0'.repeat(64);
  const PT_SET_PARAM = 14, PT_SET_INTEGRATION = 15;

  const PARAMS = [
    { id: 1,  key: 'burnFee',             label: 'Proposal fee (burned)',        kind: 'token' },
    { id: 2,  key: 'deposit',             label: 'Proposal deposit (refundable)',kind: 'token' },
    { id: 3,  key: 'minVoteBasis',        label: 'Minimum to vote',              kind: 'token' },
    { id: 4,  key: 'minDuration',         label: 'Shortest proposal',            kind: 'days'  },
    { id: 5,  key: 'maxDuration',         label: 'Longest proposal',             kind: 'days'  },
    { id: 6,  key: 'memberMultiplierBps', label: 'Pool member multiplier',       kind: 'bps'   },
    { id: 7,  key: 'stakeWeightBps',      label: 'Weight given to stakes',       kind: 'bps'   },
    { id: 8,  key: 'quorumBasis',         label: 'Participation needed (FULA)',  kind: 'token' },
    { id: 9,  key: 'quorumVoters',        label: 'Participation needed (voters)',kind: 'raw'   },
    { id: 10, key: 'maxOpenPerCreator',   label: 'Open proposals per person',    kind: 'raw'   },
    { id: 11, key: 'createCooldown',      label: 'Wait between proposals',       kind: 'days'  },
    { id: 12, key: 'minPoolJoinStake',    label: 'Pool stake for multiplier',    kind: 'token' },
    { id: 13, key: 'stakerMultiplierBps', label: 'Staker multiplier',            kind: 'bps'   }
  ];

  /* ── State ────────────────────────────────────────────────────────────── */

  let rpcIndex = 0, readWeb3 = null, votingRead = null, tokenRead = null, mcRead = null;
  let modal = null, eip155Provider = null, web3 = null, votingWrite = null, tokenWrite = null;
  let account = null, chainId = null, isAdmin = false;
  let params = {}, bounds = {}, subjects = [], filter = 'all', currentId = null;
  let userStakes = [], selectedStakes = new Set(), chosenOption = null, engineAddress = ZERO;
  let chainNow = Math.floor(Date.now() / 1000);

  const $ = id => document.getElementById(id);
  const el = {};
  ['gov-connect-btn','gov-wallet-status','gov-wallet-balance','gov-network-warning','gov-switch-btn',
   'gov-list','gov-list-loading','gov-list-empty','gov-list-error','gov-list-error-text','gov-filters',
   'gov-detail','gov-back-btn','gov-notification','gov-contract-line',
   'gov-title','gov-title-count','gov-cid','gov-cid-hint','gov-options','gov-options-count','gov-options-hint',
   'gov-add-option','gov-duration','gov-duration-label','gov-duration-hint','gov-create-btn','gov-create-error',
   'gov-cost-fee','gov-cost-deposit','gov-cost-total',
   'gov-admin-queue','gov-param-select','gov-param-info','gov-param-value','gov-param-error','gov-param-btn',
   'gov-integration-select','gov-integration-value','gov-integration-error','gov-integration-btn'
  ].forEach(id => { el[id] = $(id); });

  /* ── Small helpers ────────────────────────────────────────────────────── */

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const shortAddr = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
  const DAY = 86400n;

  /** Format wei as FULA with sensible precision — never scientific notation. */
  function fula(wei, dp = 2) {
    const n = Number(BigInt(wei ?? 0)) / 1e18;
    if (n === 0) return '0';
    if (n < 0.01) return '<0.01';
    return n.toLocaleString(undefined, { maximumFractionDigits: dp });
  }
  /**
   * Voting power is sqrt(basis in WEI), so it lives on a different scale from FULA:
   * 1 FULA of basis produces sqrt(1e18) = 1e9 power units. Dividing by 1e9 puts the
   * displayed number back on the token scale, where it reads as sqrt(FULA) — 10,000
   * FULA shows 100, 40,000 shows 200. That is what makes "four times the tokens, twice
   * the say" literally true of the numbers on screen. Formatting these with fula()
   * would divide by 1e18 and render every real vote as "<0.01".
   */
  function powerFmt(power) {
    const n = Number(BigInt(power ?? 0)) / 1e9;
    if (n === 0) return '0';
    if (n < 0.01) return '<0.01';
    return n.toLocaleString(undefined, { maximumFractionDigits: n < 100 ? 2 : 0 });
  }

  const toWei = v => {
    const s = String(v ?? '').trim();
    if (!s || isNaN(Number(s))) return 0n;
    const [i, f = ''] = s.split('.');
    return BigInt(i || '0') * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
  };

  /**
   * Integer square root, matching OpenZeppelin Math.sqrt (floor).
   * Must be exact: the contract computes power this way, and a preview that
   * disagrees with the result would be worse than no preview at all. Floating
   * point cannot represent wei-scale values, so this is BigInt Newton's method.
   */
  function isqrt(n) {
    if (n < 2n) return n;
    let x = n, y = (x + 1n) / 2n;
    while (y < x) { x = y; y = (x + n / x) / 2n; }
    return x;
  }

  function relTime(target, now) {
    let d = Number(target) - Number(now);
    const past = d < 0; d = Math.abs(d);
    const days = Math.floor(d / 86400), hrs = Math.floor((d % 86400) / 3600), mins = Math.floor((d % 3600) / 60);
    const s = days > 0 ? `${days}d ${hrs}h` : hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    return past ? `${s} ago` : `in ${s}`;
  }

  function notify(msg, type = 'success') {
    el['gov-notification'].textContent = msg;
    el['gov-notification'].className = 'gov-notification ' + type + ' show';
    setTimeout(() => el['gov-notification'].classList.remove('show'), 6000);
  }

  function busy(btn, on, text) {
    if (!btn) return;
    if (on) { btn.dataset.prev = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="gov-spinner"></span> ' + (text || 'Working…'); }
    else { btn.disabled = false; btn.innerHTML = btn.dataset.prev || text || 'Done'; }
  }

  /* ── Errors ───────────────────────────────────────────────────────────── */

  /** Map a contract error to something a person can act on. */
  const FRIENDLY = {
    AlreadyVoted: 'You have already voted on this proposal. Each wallet votes once.',
    BasisBelowMinimum: 'That is below the minimum needed to vote. Increase the amount you lock, or include a qualifying stake.',
    SubjectClosed: 'Voting on this proposal has closed.',
    SubjectStillOpen: 'This proposal has not closed yet.',
    AlreadyFinalized: 'This proposal has already been finalized.',
    CreateCooldownActive: 'You raised a proposal recently. There is a waiting period before the next one.',
    TooManyOpenSubjects: 'You already have the maximum number of open proposals.',
    StakeNotQualifying: 'One of the stakes you selected does not qualify for this proposal.',
    MembershipNotEligible: 'Your pool membership does not qualify for the multiplier.',
    NothingToClaim: 'There is nothing to claim here.',
    AlreadyClaimed: 'You have already claimed these tokens.',
    QuorumNotMet: 'This proposal did not reach the participation threshold, so the deposit is not refundable.',
    DepositIsRefundable: 'This deposit met the threshold and belongs to the proposer, so it cannot be burned.',
    DepositAlreadySettled: 'This deposit has already been settled.',
    NotSubjectCreator: 'Only the person who raised the proposal can claim its deposit.',
    DuplicateOption: 'Two options are identical. Every option must be different.',
    TitleTooLong: 'The question is too long.',
    CidTooLong: 'The IPFS link is too long to store on-chain.',
    InvalidDuration: 'That duration is outside the allowed range.',
    ExistingActiveProposal: 'Another change is already pending. It must execute or be cleared first.',
    TimeLockActive: 'This admin is still within the 24-hour delay applied at deployment.',
    RecoveryBlocked: 'Recovering the governed token is permanently blocked.',
    ERC20InsufficientAllowance: 'You have not approved enough FULA. Approve first, then try again.',
    ERC20InsufficientBalance: 'Your FULA balance is not enough for this.',
    EnforcedPause: 'Governance is paused. Claiming tokens still works; new proposals and votes do not.',
    InvalidOption: 'That option does not exist on this proposal.',
    TooManyStakeIndices: 'You selected more stakes than a single vote can carry.',
    LowBalance: 'The balance available is not enough for this.',
    ExecutionDelayNotMet: 'The 24-hour delay has not elapsed yet. This cannot be executed until then.',
    InsufficientApprovals: 'This needs a second admin to approve before it can be executed.',
    ProposalErr: 'This change cannot proceed — it may have expired, already executed, or not exist.',
    CoolDownActive: 'This action is in its cooldown period. Try again shortly.',
    Failed: 'The contract rejected this action.',
    TransferRestricted: 'The token contract refused this transfer.',
    SafeERC20FailedOperation: 'The FULA token rejected this transfer.',
    AccessControlUnauthorizedAccount: 'This wallet does not hold the role required for that action.',
    AmountMustBePositive: 'The amount must be greater than zero.',
    InvalidAddress: 'That address is not valid here.'
  };

  function explain(e) {
    const raw = e?.data?.data ?? e?.data ?? e?.cause?.data ?? e?.innerError?.data;
    const hex = typeof raw === 'string' ? raw : raw?.data;
    if (hex && typeof hex === 'string' && hex.length >= 10) {
      // Some Base RPCs strip revert data; when it IS present, decode it ourselves
      // rather than relying on the library, and fall back to the raw selector.
      for (const frag of VOTING_ABI) {
        if (frag.type !== 'error') continue;
        try {
          const sig = frag.name + '(' + (frag.inputs || []).map(i => i.type).join(',') + ')';
          if (readWeb3.utils.keccak256(sig).slice(0, 10) === hex.slice(0, 10)) {
            return FRIENDLY[frag.name] || frag.name;
          }
        } catch (_) { /* keep scanning */ }
      }
      const known = { '0xfb8f41b2': 'ERC20InsufficientAllowance', '0xe450d38c': 'ERC20InsufficientBalance' }[hex.slice(0, 10)];
      if (known) return FRIENDLY[known];
      return 'The transaction was rejected by the contract (' + hex.slice(0, 10) + ').';
    }
    const m = String(e?.message ?? e);
    if (/user rejected|denied/i.test(m)) return 'You cancelled the transaction.';
    if (/insufficient funds/i.test(m)) return 'Not enough ETH on Base to pay for gas.';
    for (const k of Object.keys(FRIENDLY)) if (m.includes(k)) return FRIENDLY[k];
    return m.length > 160 ? m.slice(0, 160) + '…' : m;
  }

  /* ── Read layer ───────────────────────────────────────────────────────── */

  function buildRead() {
    readWeb3 = new Web3(RPC_URLS[rpcIndex]);
    votingRead = new readWeb3.eth.Contract(VOTING_ABI, CONFIG.VOTING);
    tokenRead = new readWeb3.eth.Contract(TOKEN_ABI, CONFIG.TOKEN);
    mcRead = new readWeb3.eth.Contract(MULTICALL3_ABI, MULTICALL3);
  }
  function rotate() { rpcIndex = (rpcIndex + 1) % RPC_URLS.length; buildRead(); }

  /**
   * Run a read, rotating through the RPC pool on failure. `fn` must reference the
   * module-level contract objects so it picks up the rebuilt instance after a rotate.
   */
  async function read(fn) {
    let last;
    for (let i = 0; i < RPC_URLS.length; i++) {
      try { return await fn(); }
      catch (e) { last = e; rotate(); }
    }
    throw last;
  }

  /** Probe from the best RPC down, so a dead or wrong-chain endpoint never starts a load. */
  async function ensureHealthyRpc() {
    rpcIndex = 0; buildRead();
    for (let i = 0; i < RPC_URLS.length; i++) {
      try { if (Number(await readWeb3.eth.getChainId()) === CONFIG.CHAIN_ID) return true; } catch (_) { /* dead endpoint */ }
      rotate();
    }
    return false;
  }

  /**
   * Fetch logs, treating an EMPTY result as "this endpoint does not know" rather than
   * as "there are none". Measured on Base: publicnode prunes older logs and answers
   * with a successful empty array, while drpc, base.org and tenderly return the very
   * same log. Accepting the first empty answer is how a ballot silently loses its
   * labels. Every endpoint must agree before nothing is reported.
   *
   * Returns on the first non-empty result and leaves the RPC pointer there, so the
   * endpoint that actually has the data serves the following slices too.
   */
  async function readLogs(params) {
    for (let i = 0; i < RPC_URLS.length; i++) {
      try {
        const logs = await readWeb3.eth.getPastLogs(params);
        if (logs && logs.length) return logs;
      } catch (_) { /* range rejected, endpoint down, or rate-limited */ }
      rotate();
    }
    return [];
  }

  /** Batch reads through Multicall3 — one request instead of N, which is what public RPCs tolerate. */
  async function multicall(calls) {
    // Positional arrays for the tuple input: more robust across web3 builds than named keys.
    const payload = calls.map(c => [c.target, true, c.data]);
    const res = await read(() => mcRead.methods.aggregate3(payload).call());
    return res.map((r, i) => {
      const ok = r?.success !== undefined ? r.success : r?.[0];
      const data = r?.returnData !== undefined ? r.returnData : r?.[1];
      // A successful-but-empty response is "unknown", never zero. Treating short
      // data as a valid zero is how a silent wrong number reaches the screen.
      if (!(ok === true || ok === 'true') || !data || data === '0x') return null;
      try { return readWeb3.eth.abi.decodeParameters(calls[i].outputs, data); }
      catch (_) { return null; }
    });
  }

  /**
   * Poll until a read agrees with expectations. Base RPCs serve pre-transaction
   * state for seconds after a write, which makes a successful action look failed.
   */
  async function settle(check, tries = 12) {
    for (let i = 0; i < tries; i++) {
      try { if (await check()) return true; } catch (_) { /* keep trying */ }
      await new Promise(r => setTimeout(r, 2500));
    }
    return false;
  }

  /** Wait until the read RPC has caught up to a mined block, so the next read is not pre-state. */
  async function waitForReadSync(blockNumber) {
    if (!blockNumber) return;
    const target = Number(blockNumber);
    for (let i = 0; i < 12; i++) {
      try { if (Number(await readWeb3.eth.getBlockNumber()) >= target) return; } catch (_) { /* retry */ }
      await new Promise(r => setTimeout(r, 800));
    }
  }

  /**
   * Estimate gas through the public RPC rather than the wallet. Mobile WalletConnect
   * wallets estimate unreliably, and a failed estimate there surfaces as an opaque
   * rejection. Headroom covers EIP-150 63/64 forwarding on nested calls.
   *
   * Doubles as a pre-flight check: if the estimate reverts, the transaction would
   * revert too, so it is raised here — the user reads "You have already voted"
   * instead of signing, paying, and watching it fail. Because some Base RPCs strip
   * revert data and others do not, every endpoint is tried and the richest error
   * kept. Only a revert is fatal; ordinary RPC flakiness falls back to a fixed gas.
   */
  async function estimateGas(data, to, fallback) {
    let revert = null;
    for (let i = 0; i < RPC_URLS.length; i++) {
      try {
        const g = await readWeb3.eth.estimateGas({ from: account, to, data });
        return Math.ceil(Number(g) * 1.4);
      } catch (e) {
        const hasData = !!(e?.data ?? e?.cause?.data ?? e?.innerError?.data);
        if (hasData || /execution reverted|revert/i.test(String(e?.message ?? e))) {
          if (hasData || !revert) revert = e;   // prefer an error that carries decodable data
        }
        rotate();
      }
    }
    if (revert) throw revert;
    return fallback || 600000;  // no endpoint reported a revert, so this is RPC flakiness
  }

  /**
   * Base-appropriate EIP-1559 fees. Without these some wallets apply an Ethereum-scale
   * ~2.5 gwei tip on Base, roughly 100x more than needed. A wallet that ignores
   * dApp-supplied fees just uses its own, which is no worse than not setting them.
   */
  async function getFeeParams() {
    try {
      const blk = await read(() => readWeb3.eth.getBlock('latest'));
      const base = BigInt(blk.baseFeePerGas);
      const priority = 5000000n;
      return { maxFeePerGas: base * 2n + 50000000n + priority, maxPriorityFeePerGas: priority };
    } catch (_) { return {}; }
  }

  /** Rebind the write contracts to the live provider — AppKit can swap it underneath us. */
  function bindWrite() {
    web3 = new Web3(eip155Provider);
    votingWrite = new web3.eth.Contract(VOTING_ABI, CONFIG.VOTING);
    tokenWrite = new web3.eth.Contract(TOKEN_ABI, CONFIG.TOKEN);
  }

  /**
   * Send a transaction and wait for the read RPC to catch up.
   * Retries the transient faults this chain produces — chiefly `nonce too low`,
   * which public Base RPCs return for seconds after a preceding send.
   */
  async function send(method, to, gasFallback) {
    const data = method.encodeABI();
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const gas = await estimateGas(data, to || CONFIG.VOTING, gasFallback);
        const fees = await getFeeParams();
        const receipt = await method.send({ from: account, gas, ...fees });
        await waitForReadSync(receipt && receipt.blockNumber);
        return receipt;
      } catch (e) {
        const m = String(e?.message ?? e);
        if (/user rejected|denied|ACTION_REJECTED/i.test(m) || e?.code === 4001) throw e;
        const transient = /nonce too low|replacement transaction|already known|Temporary internal error|failed to fetch/i.test(m);
        if (!transient || attempt === 3) throw e;
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  /* ── Ballot labels from logs ──────────────────────────────────────────── */

  const labelCache = new Map();

  function cacheKey(id) { return 'fula-gov-opts-' + CONFIG.VOTING + '-' + id; }

  /**
   * Find a subject's SubjectOptions log without scanning the chain.
   *
   * Public Base RPCs reject any eth_getLogs range wider than ~10k blocks (measured:
   * drpc and sepolia.base.org 400 at 45k, publicnode fails above that). Walking back
   * from head in 10k steps therefore costs one request per 10k blocks — about 130 a
   * month after deployment, growing without limit. Unusable within weeks.
   *
   * Instead, anchor on time. Base produces a block every 2 seconds, and `createdAt`
   * is known exactly from the subject itself, so the creating block is predictable to
   * within a handful of blocks. Search a small window around that estimate and widen
   * only if it misses. Cost is O(1) requests per subject no matter how old it is.
   */
  async function findOptionsLog(id, createdAt) {
    const topic = readWeb3.utils.keccak256('SubjectOptions(uint256,string[])');
    const idTopic = '0x' + BigInt(id).toString(16).padStart(64, '0');
    const head = await read(() => readWeb3.eth.getBlock('latest'));
    const latest = Number(head.number);
    const est = Math.max(CONFIG.DEPLOY_BLOCK, Math.min(latest,
      latest - Math.floor((Number(head.timestamp) - Number(createdAt)) / CONFIG.BLOCK_TIME)));

    const scanRange = async (from, to) => {
      for (let lo = from; lo <= to; lo += CONFIG.LOG_CHUNK) {
        const hi = Math.min(to, lo + CONFIG.LOG_CHUNK - 1);
        const logs = await readLogs({ address: CONFIG.VOTING, topics: [topic, idTopic], fromBlock: lo, toBlock: hi });
        if (logs.length) return logs[logs.length - 1];
      }
      return null;
    };

    let doneLo = null, doneHi = null;
    for (const half of [4500, 15000, 50000, 150000]) {
      const from = Math.max(CONFIG.DEPLOY_BLOCK, est - half);
      const to = Math.min(latest, est + half);
      const slices = doneLo === null
        ? [[from, to]]
        : [[from, doneLo - 1], [doneHi + 1, to]].filter(([a, b]) => a <= b);
      for (const [a, b] of slices) {
        const hit = await scanRange(a, b);
        if (hit) return hit;
      }
      doneLo = from; doneHi = to;
      if (from === CONFIG.DEPLOY_BLOCK && to === latest) break; // whole chain covered
    }
    return null;
  }

  /**
   * Recover a subject's option labels and verify each against the on-chain
   * keccak256 commitment. Returns { labels, verified, missing }.
   *
   * The contract stores only hashes, so logs are the only source of the text — and
   * verifying against the commitment means no RPC, gateway or cache can substitute
   * different wording for what voters actually committed to. Labels may be cached,
   * but verification always runs live: a cached label that no longer hashes to its
   * commitment is reported as unverified rather than trusted.
   */
  async function loadLabels(id, optionCount, createdAt) {
    if (labelCache.has(id)) return labelCache.get(id);

    let labels = null;
    try {
      const cached = localStorage.getItem(cacheKey(id));
      if (cached) { const arr = JSON.parse(cached); if (Array.isArray(arr) && arr.length) labels = arr; }
    } catch (_) { /* storage unavailable or blocked */ }

    if (!labels) {
      try {
        const log = await findOptionsLog(id, createdAt);
        if (log) labels = readWeb3.eth.abi.decodeParameters(['string[]'], log.data)[0];
      } catch (_) { /* fall through to the numbered fallback */ }
    }

    if (!labels || !labels.length) {
      const fallback = { labels: Array.from({ length: optionCount }, (_, i) => 'Option ' + (i + 1)), verified: false, missing: true };
      labelCache.set(id, fallback);   // in-memory only, so a reload retries
      return fallback;
    }

    let verified = true;
    try {
      const hashes = await multicall(labels.map((_, i) => ({
        target: CONFIG.VOTING,
        data: votingRead.methods.optionHashes(id, i).encodeABI(),
        outputs: ['bytes32']
      })));
      for (let i = 0; i < labels.length; i++) {
        const onChain = hashes[i]?.[0];
        const computed = readWeb3.utils.keccak256(readWeb3.utils.utf8ToHex(labels[i]));
        if (!onChain || onChain.toLowerCase() !== computed.toLowerCase()) { verified = false; break; }
      }
    } catch (_) { verified = false; }

    const result = { labels, verified, missing: false };
    labelCache.set(id, result);
    // Only a verified ballot is worth persisting; anything else must be re-fetched.
    if (verified) { try { localStorage.setItem(cacheKey(id), JSON.stringify(labels)); } catch (_) { /* ignore */ } }
    else { try { localStorage.removeItem(cacheKey(id)); } catch (_) { /* ignore */ } }
    return result;
  }

  /* ── IPFS ─────────────────────────────────────────────────────────────── */

  /**
   * Accept a bare CID or any common gateway form and return the CID.
   * Recognises ipfs://, /ipfs/<cid> paths, and <cid>.ipfs.<gateway> subdomains.
   */
  function parseCid(input) {
    const s = String(input ?? '').trim();
    if (!s) return '';
    const isCid = v => /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(v) || /^ba[a-z2-7]{57,}$/i.test(v);
    if (isCid(s)) return s;
    if (s.startsWith('ipfs://')) { const c = s.slice(7).split(/[/?#]/)[0]; return isCid(c) ? c : ''; }
    const path = s.match(/\/ipfs\/([^/?#\s]+)/i);
    if (path && isCid(path[1])) return path[1];
    const sub = s.match(/^https?:\/\/([^.]+)\.ipfs\./i);
    if (sub && isCid(sub[1])) return sub[1];
    return '';
  }

  async function fetchIpfs(cid) {
    for (const gw of IPFS_GATEWAYS) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 6000);
        const r = await fetch(gw + cid, { signal: ctl.signal });
        clearTimeout(t);
        if (r.ok) return await r.text();
      } catch (_) { /* try the next gateway */ }
    }
    return null;
  }

  /* ── Voting power ─────────────────────────────────────────────────────── */

  /**
   * Reproduce the contract's power calculation exactly:
   *   weightedStake = sum(qualifying) * stakeWeightBps / 10000   (summed FIRST, weighted ONCE)
   *   basis         = freshLock + weightedStake
   *   multiplier    = stakerMultiplier if weightedStake >= minVoteBasis, else 1x
   *                   (× memberMultiplier when a pool membership is proven)
   *                   capped at 5x combined
   *   power         = sqrt(basis) * multiplier / 10000           (root FIRST, then multiply)
   */
  function computePower(subject, lockWei, stakeSumWei, hasMembership) {
    const weighted = (stakeSumWei * BigInt(subject.stakeWeightBpsAt)) / 10000n;
    const basis = lockWei + weighted;
    let mult = 10000n;
    if (weighted >= BigInt(subject.minVoteBasisAt)) mult = BigInt(subject.stakerMultiplierBpsAt);
    if (hasMembership) mult = (mult * BigInt(subject.memberMultiplierBpsAt)) / 10000n;
    if (mult > 50000n) mult = 50000n;
    const power = (isqrt(basis) * mult) / 10000n;
    return { basis, weighted, mult, power };
  }

  /** Why a stake does or does not qualify — the rules are not obvious. */
  function stakeStatus(stake, subject) {
    if (!stake.isActive) return 'Not active';
    const end = BigInt(stake.startTime) + BigInt(stake.lockPeriod);
    if (end < BigInt(subject.closeTime)) return 'Unlocks before this proposal closes';
    if (BigInt(stake.startTime) > BigInt(subject.createdAt)) return 'Opened after this proposal was raised';
    return null;
  }

  /* ── Wallet ───────────────────────────────────────────────────────────── */

  async function initWallet() {
    const adapter = new WagmiAdapter({ networks: [networks.base], projectId: CONFIG.PROJECT_ID });
    modal = createAppKit({
      adapters: [adapter],
      networks: [networks.base],
      defaultNetwork: networks.base,
      projectId: CONFIG.PROJECT_ID,
      metadata: {
        name: 'Fula Governance',
        description: 'Vote on Fula network proposals',
        url: 'https://fulanetwork.github.io/proposals/',
        icons: ['https://fulanetwork.github.io/assets/images/logo/fula-icon-green.png']
      },
      features: { analytics: false, email: false, socials: false }
    });

    modal.subscribeAccount(s => { onAccount(s && s.isConnected && s.address ? s.address : null); });
    modal.subscribeNetwork(s => { chainId = s?.chainId != null ? Number(s.chainId) : null; renderNetwork(); });
    modal.subscribeProviders(s => {
      eip155Provider = (s && s['eip155']) || null;
      if (eip155Provider) bindWrite();
    });
    try { WagmiCore.reconnect(adapter.wagmiConfig); } catch (_) { /* no prior session */ }
  }

  /**
   * Get the wallet onto Base. Multi-chain WalletConnect wallets update their chainId
   * asynchronously via `chainChanged` AFTER switchNetwork() resolves, so one immediate
   * re-read is stale and falsely reports failure. Try AppKit, then the raw RPC calls,
   * then poll — accepting either the direct read or wagmi's reported chain.
   */
  async function ensureOnBase() {
    if (!eip155Provider) return false;
    const readChain = async () => parseInt(await eip155Provider.request({ method: 'eth_chainId' }), 16);
    try { if (await readChain() === CONFIG.CHAIN_ID) return true; } catch (_) { /* fall through */ }
    try { await modal.switchNetwork(networks.base); } catch (_) { /* fall through to the raw call */ }
    try {
      await eip155Provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CONFIG.CHAIN_ID_HEX }] });
    } catch (e) {
      if (e?.code === 4902) {
        try {
          await eip155Provider.request({
            method: 'wallet_addEthereumChain',
            params: [{ chainId: CONFIG.CHAIN_ID_HEX, chainName: CONFIG.CHAIN_NAME, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [RPC_URLS[0]], blockExplorerUrls: [CONFIG.EXPLORER] }]
          });
        } catch (_) { /* the wallet declined to add it */ }
      }
    }
    for (let i = 0; i < 8; i++) {
      try { if (await readChain() === CONFIG.CHAIN_ID) return true; } catch (_) { /* retry */ }
      if (chainId === CONFIG.CHAIN_ID) return true;
      await new Promise(r => setTimeout(r, 350));
    }
    return false;
  }

  async function requireWallet() {
    if (!account) { notify('Connect your wallet first.', 'warning'); modal.open(); return false; }
    if (!eip155Provider) { notify('Wallet is still connecting. Try again in a moment.', 'warning'); return false; }
    if (!(await ensureOnBase())) { notify('Please switch to Base to continue.', 'warning'); return false; }
    bindWrite();
    return true;
  }

  function renderNetwork() {
    const wrong = !!account && chainId !== null && chainId !== CONFIG.CHAIN_ID;
    el['gov-network-warning'].hidden = !wrong;
  }

  async function onAccount(addr) {
    account = addr;
    el['gov-connect-btn'].textContent = addr ? 'Disconnect' : 'Connect Wallet';
    el['gov-wallet-status'].textContent = addr ? shortAddr(addr) : 'Not connected';
    el['gov-wallet-balance'].textContent = '';
    renderNetwork();
    if (!addr) {
      isAdmin = false; userStakes = [];
      $('tab-btn-admin').hidden = true;
      renderList();
      if (currentId !== null) renderDetail(currentId);
      updateCreateState();
      return;
    }
    try {
      const [bal, admin] = await Promise.all([
        read(() => tokenRead.methods.balanceOf(addr).call()),
        read(() => votingRead.methods.hasRole(ADMIN_ROLE, addr).call())
      ]);
      el['gov-wallet-balance'].textContent = fula(bal) + ' FULA';
      isAdmin = !!admin;
      $('tab-btn-admin').hidden = !isAdmin;
      if (isAdmin) loadAdmin();
    } catch (_) { /* balance is cosmetic */ }
    await loadStakes();
    renderList();
    if (currentId !== null) renderDetail(currentId);
    updateCreateState();
  }

  async function loadStakes() {
    userStakes = [];
    if (!account || engineAddress === ZERO) return;
    try {
      // Rebuilt inside the closure so a rotate() mid-retry does not keep using the dead provider.
      userStakes = await read(() => new readWeb3.eth.Contract(STAKING_ABI, engineAddress).methods.getUserStakes(account).call());
    } catch (_) { userStakes = []; }
  }

  /* ── Loading ──────────────────────────────────────────────────────────── */

  async function loadParams() {
    const calls = PARAMS.flatMap(p => ([
      { target: CONFIG.VOTING, data: votingRead.methods.paramValue(p.id).encodeABI(), outputs: ['uint256'] },
      { target: CONFIG.VOTING, data: votingRead.methods.paramBounds(p.id).encodeABI(), outputs: ['uint256', 'uint256'] }
    ]));
    const res = await multicall(calls);
    PARAMS.forEach((p, i) => {
      const v = res[i * 2], b = res[i * 2 + 1];
      if (v) params[p.key] = BigInt(v[0]);
      if (b) bounds[p.key] = [BigInt(b[0]), BigInt(b[1])];
    });
  }

  async function loadSubjects() {
    const count = Number(await read(() => votingRead.methods.subjectCount().call()));
    if (!count) return [];
    const calls = [];
    for (let id = 1; id <= count; id++) {
      calls.push({ target: CONFIG.VOTING, data: votingRead.methods.getSubject(id).encodeABI(), outputs: [{ components: SUBJECT_OUT, type: 'tuple' }] });
    }
    const res = await multicall(calls);
    const out = [];
    for (let i = 0; i < res.length; i++) {
      if (!res[i]) continue;
      const s = res[i][0];
      out.push({
        id: i + 1,
        creator: s.creator, createdAt: BigInt(s.createdAt), closeTime: BigInt(s.closeTime),
        optionCount: Number(s.optionCount), deposit: BigInt(s.deposit), voterCount: Number(s.voterCount),
        winningOption: Number(s.winningOption), status: Number(s.status), tied: s.tied,
        depositRefundable: s.depositRefundable, depositSettled: s.depositSettled,
        totalPowerCast: BigInt(s.totalPowerCast), totalBasis: BigInt(s.totalBasis),
        quorumBasisAt: BigInt(s.quorumBasisAt), quorumVotersAt: Number(s.quorumVotersAt),
        memberMultiplierBpsAt: Number(s.memberMultiplierBpsAt), stakerMultiplierBpsAt: Number(s.stakerMultiplierBpsAt),
        stakeWeightBpsAt: Number(s.stakeWeightBpsAt), minVoteBasisAt: BigInt(s.minVoteBasisAt),
        minPoolJoinStakeAt: BigInt(s.minPoolJoinStakeAt), title: s.title, descriptionCID: s.descriptionCID
      });
    }
    return out.reverse(); // newest first
  }

  async function loadTallies(s) {
    const calls = [];
    for (let i = 0; i < s.optionCount; i++) {
      calls.push({ target: CONFIG.VOTING, data: votingRead.methods.tally(s.id, i).encodeABI(), outputs: ['uint128'] });
    }
    const res = await multicall(calls);
    return res.map(r => (r ? BigInt(r[0]) : 0n));
  }

  /* ── Rendering: list ──────────────────────────────────────────────────── */

  function statusOf(s) {
    if (chainNow < Number(s.closeTime)) return { key: 'open', label: 'Open' };
    if (s.status === 1) return s.tied ? { key: 'tied', label: 'No majority' } : { key: 'finalized', label: 'Decided' };
    return { key: 'closed', label: 'Closed' };
  }

  function renderList() {
    const host = el['gov-list'];
    const shown = subjects.filter(s => {
      if (filter === 'open') return chainNow < Number(s.closeTime);
      if (filter === 'closed') return chainNow >= Number(s.closeTime);
      return true;
    });
    el['gov-list-loading'].hidden = true;
    el['gov-list-empty'].hidden = shown.length > 0 || subjects.length > 0;
    host.hidden = shown.length === 0;
    if (!shown.length) {
      if (subjects.length > 0) {
        host.hidden = false;
        host.innerHTML = '<div class="gov-empty"><p class="gov-empty__text">No proposals match this filter.</p></div>';
      }
      return;
    }
    host.innerHTML = shown.map(s => {
      const st = statusOf(s);
      const quorumMet = s.voterCount >= s.quorumVotersAt && s.totalBasis >= s.quorumBasisAt;
      return `
        <article class="gov-card gov-card--clickable" data-id="${s.id}" tabindex="0" role="button" aria-label="Open proposal: ${esc(s.title)}">
          <div class="gov-card__top">
            <h3 class="gov-card__title">${esc(s.title || 'Untitled proposal')}</h3>
            <span class="gov-pill gov-pill--${st.key}">${st.label}</span>
          </div>
          <div class="gov-card__meta">
            <span>${st.key === 'open' ? 'Closes ' + relTime(s.closeTime, chainNow) : 'Closed ' + relTime(s.closeTime, chainNow)}</span>
            <span>${s.voterCount} ${s.voterCount === 1 ? 'voter' : 'voters'}</span>
            <span>${fula(s.totalBasis)} FULA committed</span>
            <span>${quorumMet ? 'Threshold met' : 'Below threshold'}</span>
          </div>
        </article>`;
    }).join('');
    host.querySelectorAll('.gov-card').forEach(c => {
      const go = () => openDetail(Number(c.dataset.id));
      c.addEventListener('click', go);
      c.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }

  /* ── Rendering: detail ────────────────────────────────────────────────── */

  function openDetail(id) {
    currentId = id;
    $('tab-proposals').hidden = true;
    $('tab-detail').hidden = false;
    renderDetail(id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function closeDetail() {
    currentId = null;
    chosenOption = null; selectedStakes.clear();
    $('tab-detail').hidden = true;
    $('tab-proposals').hidden = false;
  }

  async function renderDetail(id) {
    const s = subjects.find(x => x.id === id);
    if (!s) { closeDetail(); return; }
    const host = el['gov-detail'];
    host.innerHTML = '<div class="gov-loading"><span class="gov-spinner"></span> Loading&hellip;</div>';

    const [tallies, ballot] = await Promise.all([loadTallies(s), loadLabels(s.id, s.optionCount, s.createdAt)]);
    let receipt = null;
    if (account) {
      try { receipt = await read(() => votingRead.methods.getReceipt(s.id, account).call()); } catch (_) { /* not voted */ }
    }
    const st = statusOf(s);
    const open = chainNow < Number(s.closeTime);
    const totalPower = tallies.reduce((a, b) => a + b, 0n);
    const quorumMet = s.voterCount >= s.quorumVotersAt && s.totalBasis >= s.quorumBasisAt;

    const optionsHtml = ballot.labels.map((label, i) => {
      const t = tallies[i] || 0n;
      const pct = totalPower > 0n ? Number((t * 1000n) / totalPower) / 10 : 0;
      const isWinner = !open && s.status === 1 && !s.tied && s.winningOption === i;
      const chosen = chosenOption === i;
      const selectable = open && !receipt?.voted;
      return `
        <div class="gov-option ${isWinner ? 'gov-option--winner' : ''} ${selectable ? 'gov-option--selectable' : ''} ${chosen ? 'gov-option--chosen' : ''}"
             ${selectable ? `data-opt="${i}" role="button" tabindex="0"` : ''}>
          <div class="gov-option__row">
            <span class="gov-option__label">${selectable ? `<span class="gov-option__mark">${chosen ? '●' : '○'}</span> ` : ''}${esc(label)}${isWinner ? ' ✓' : ''}</span>
            <span class="gov-option__pct">${pct.toFixed(1)}%</span>
          </div>
          <div class="gov-bar"><div class="gov-bar__fill" style="width:${pct}%"></div></div>
        </div>`;
    }).join('');

    const verifyBadge = ballot.missing
      ? '<span class="gov-pill gov-pill--unverified">Labels unavailable</span>'
      : ballot.verified
        ? '<span class="gov-pill gov-pill--verified">✓ Ballot verified on-chain</span>'
        : '<span class="gov-pill gov-pill--unverified">⚠ Ballot does not match the chain</span>';

    host.innerHTML = `
      <div class="gov-card">
        <div class="gov-card__top">
          <h2 class="gov-card__title">${esc(s.title || 'Untitled proposal')}</h2>
          <span class="gov-pill gov-pill--${st.key}">${st.label}</span>
        </div>
        <div class="gov-card__meta">
          <span>Raised by ${shortAddr(s.creator)}</span>
          <span>${open ? 'Closes ' + relTime(s.closeTime, chainNow) : 'Closed ' + relTime(s.closeTime, chainNow)}</span>
          <span>${verifyBadge}</span>
        </div>
        <div id="gov-desc" class="gov-hint"></div>
        <div class="gov-options">${optionsHtml}</div>
        ${ballot.missing ? '<p class="gov-hint gov-hint--warn">The option text is published in the creation event and could not be loaded from any RPC just now. The numbered choices above are still correct and votes are unaffected — reload to try again.</p>' : ''}

        <div class="gov-quorum">
          <div class="gov-quorum__row"><span>Participation</span><span>${s.voterCount} / ${s.quorumVotersAt} voters &middot; ${fula(s.totalBasis)} / ${fula(s.quorumBasisAt)} FULA</span></div>
          <div class="gov-bar"><div class="gov-bar__fill" style="width:${Math.min(100, s.quorumBasisAt > 0n ? Number((s.totalBasis * 100n) / s.quorumBasisAt) : 0)}%"></div></div>
          <p class="gov-hint">${quorumMet ? 'This proposal reached the participation threshold, so the proposer’s deposit is returned.' : 'Below the threshold. If it closes this way, the proposer’s deposit is burned.'}</p>
        </div>

        <div id="gov-vote-area"></div>
        <div id="gov-actions" class="gov-actions"></div>
      </div>`;

    // Description from IPFS, loaded lazily so it never blocks the ballot.
    if (s.descriptionCID) {
      const cid = parseCid(s.descriptionCID) || s.descriptionCID;
      const d = $('gov-desc');
      d.innerHTML = 'Loading the full description&hellip;';
      fetchIpfs(cid).then(text => {
        if (text && text.length < 20000) {
          d.innerHTML = '<div class="gov-info" style="margin-top:.75rem"><p style="white-space:pre-wrap">' + esc(text.slice(0, 8000)) + '</p></div>';
        } else {
          d.innerHTML = `Full description: <a href="${IPFS_GATEWAYS[0]}${esc(cid)}" target="_blank" rel="noopener">open on IPFS</a>`;
        }
      });
    }

    // Toggle the selection in place rather than re-rendering. A re-render rebuilds the
    // vote panel, which would wipe the amount the user typed and reset the stake
    // checkboxes while `selectedStakes` still held them — so the vote would silently
    // include stakes no longer shown as ticked.
    const options = Array.from(host.querySelectorAll('[data-opt]'));
    options.forEach(node => {
      const pick = () => {
        chosenOption = Number(node.dataset.opt);
        options.forEach(o => {
          const on = o === node;
          o.classList.toggle('gov-option--chosen', on);
          const mark = o.querySelector('.gov-option__mark');
          if (mark) mark.textContent = on ? '●' : '○';
        });
        updatePower(s);
      };
      node.addEventListener('click', pick);
      node.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });

    renderVoteArea(s, receipt, open);
    renderActions(s, receipt, open, quorumMet);
  }

  function renderVoteArea(s, receipt, open) {
    const host = $('gov-vote-area');
    if (!host) return;

    if (receipt?.voted) {
      host.innerHTML = `
        <div class="gov-receipt">
          <strong>You voted.</strong>
          <div class="gov-receipt__grid">
            <div><span class="gov-receipt__label">Your choice</span><span class="gov-receipt__value">${esc((labelCache.get(s.id)?.labels || [])[Number(receipt.option)] || ('Option ' + (Number(receipt.option) + 1)))}</span></div>
            <div><span class="gov-receipt__label">Committed</span><span class="gov-receipt__value">${fula(receipt.basis)} FULA</span></div>
            <div><span class="gov-receipt__label">Voting power</span><span class="gov-receipt__value">${powerFmt(receipt.power)}</span></div>
            <div><span class="gov-receipt__label">Locked</span><span class="gov-receipt__value">${fula(receipt.lockedAmount)} FULA</span></div>
          </div>
          ${Number(receipt.multiplierBps) > 10000 ? `<p class="gov-hint gov-hint--ok">A ${(Number(receipt.multiplierBps) / 10000).toFixed(2)}× commitment multiplier was applied.</p>` : ''}
          ${open ? '<p class="gov-hint">Your locked FULA can be claimed once this proposal closes.</p>' : ''}
        </div>`;
      return;
    }
    if (!open) { host.innerHTML = ''; return; }

    const qualifying = userStakes.map((st, i) => ({ st, i, why: stakeStatus(st, s) }));
    const anyStakes = qualifying.length > 0;
    host.innerHTML = `
      <div class="gov-quorum">
        <div class="gov-field">
          <label class="gov-label" for="gov-lock">Lock FULA to vote <span class="gov-counter">returned when the proposal closes</span></label>
          <div class="gov-input-wrap">
            <input type="text" inputmode="decimal" id="gov-lock" class="gov-input" placeholder="0">
            <button class="gov-input-btn" id="gov-lock-max" type="button">MAX</button>
          </div>
          <p class="gov-hint">Minimum ${fula(s.minVoteBasisAt)} FULA, counting any stakes you include.</p>
        </div>
        ${anyStakes ? `
        <div class="gov-field">
          <label class="gov-label">Include your stakes <span class="gov-counter">nothing is transferred</span></label>
          <div class="gov-stakes">
            ${qualifying.map(q => `
              <label class="gov-stake ${q.why ? 'gov-stake--no' : 'gov-stake--ok'}">
                <input type="checkbox" data-stake="${q.i}" ${q.why ? 'disabled' : ''}>
                <span class="gov-stake__body">
                  <span class="gov-stake__amount">${fula(q.st.amount)} FULA</span>
                  <span class="gov-stake__why">${q.why ? esc(q.why) : 'Qualifies'}</span>
                </span>
              </label>`).join('')}
          </div>
        </div>` : (engineAddress !== ZERO && account ? '<p class="gov-hint">No stakes found for this wallet in the staking contract used by governance.</p>' : '')}

        <div class="gov-power" id="gov-power"></div>
        <p class="gov-hint gov-hint--error" id="gov-vote-error"></p>
        <button class="btn btn--primary btn--lg gov-submit" id="gov-vote-btn">Choose an option above</button>
      </div>`;

    const lockInput = $('gov-lock');
    lockInput.addEventListener('input', () => updatePower(s));
    $('gov-lock-max').addEventListener('click', async () => {
      if (!account) return;
      try { lockInput.value = (Number(BigInt(await read(() => tokenRead.methods.balanceOf(account).call()))) / 1e18).toFixed(4); updatePower(s); } catch (_) {}
    });
    host.querySelectorAll('[data-stake]').forEach(cb => cb.addEventListener('change', () => {
      const i = Number(cb.dataset.stake);
      if (cb.checked) selectedStakes.add(i); else selectedStakes.delete(i);
      updatePower(s);
    }));
    $('gov-vote-btn').addEventListener('click', () => doVote(s));
    updatePower(s);
  }

  function selectedStakeSum() {
    let sum = 0n;
    selectedStakes.forEach(i => { if (userStakes[i]) sum += BigInt(userStakes[i].amount); });
    return sum;
  }

  function updatePower(s) {
    const box = $('gov-power'); if (!box) return;
    const lock = toWei($('gov-lock')?.value);
    const { basis, power, mult } = computePower(s, lock, selectedStakeSum(), false);
    const btn = $('gov-vote-btn');
    const below = basis < BigInt(s.minVoteBasisAt);

    box.innerHTML = basis === 0n
      ? '<div class="gov-power__note">Enter an amount to see the voting power it gives you.</div>'
      : `<div class="gov-power__value">${powerFmt(power)} voting power</div>
         <div class="gov-power__note">
           From ${fula(basis)} FULA committed${mult > 10000n ? `, including a ${(Number(mult) / 10000).toFixed(2)}× commitment multiplier` : ''}.
           Committing four times as much would give you twice this — that is what keeps large holders from buying a proportional share of the outcome.
         </div>`;

    if (btn) {
      if (chosenOption === null) { btn.disabled = true; btn.textContent = 'Choose an option above'; }
      else if (below) { btn.disabled = true; btn.textContent = `Minimum ${fula(s.minVoteBasisAt)} FULA`; }
      else { btn.disabled = false; btn.textContent = 'Vote'; }
    }
  }

  function renderActions(s, receipt, open, quorumMet) {
    const host = $('gov-actions'); if (!host) return;
    const bits = [];
    if (!open && s.status === 0) bits.push(`<button class="btn btn--outline" id="act-finalize">Record the result</button>`);
    if (!open && receipt?.voted && !receipt.claimed && BigInt(receipt.lockedAmount) > 0n) bits.push(`<button class="btn btn--primary" id="act-claim">Claim your ${fula(receipt.lockedAmount)} FULA</button>`);
    if (!open && !s.depositSettled && account && account.toLowerCase() === s.creator.toLowerCase() && quorumMet) bits.push(`<button class="btn btn--primary" id="act-claim-deposit">Claim your deposit</button>`);
    if (!open && !s.depositSettled && !quorumMet) bits.push(`<button class="btn btn--outline" id="act-settle">Settle the failed deposit</button>`);
    host.innerHTML = bits.join('');
    if (bits.length && (bits.some(b => b.includes('act-finalize')) || bits.some(b => b.includes('act-settle')))) {
      host.insertAdjacentHTML('beforeend', '<p class="gov-hint">Recording a result and settling a failed deposit can be done by anyone — they are not restricted to the proposer.</p>');
    }
    const wire = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', () => fn(b)); };
    wire('act-finalize', b => txn(b, 'Recording…', () => votingWrite.methods.finalize(s.id), 'Result recorded.'));
    wire('act-claim', b => txn(b, 'Claiming…', () => votingWrite.methods.claim(s.id), 'Tokens returned to your wallet.'));
    wire('act-claim-deposit', b => txn(b, 'Claiming…', () => votingWrite.methods.claimDeposit(s.id), 'Deposit returned.'));
    wire('act-settle', b => txn(b, 'Settling…', () => votingWrite.methods.settleDeposit(s.id), 'Deposit settled.'));
  }

  /** Run a write, with wallet/network guards, retries and a refresh afterwards. */
  async function txn(btn, working, build, okMsg) {
    if (!(await requireWallet())) return;
    busy(btn, true, working);
    try {
      await send(build(), CONFIG.VOTING, 500000);
      notify(okMsg);
      await refresh();
      if (currentId !== null) await renderDetail(currentId);
    } catch (e) {
      notify(explain(e), 'error');
    } finally { busy(btn, false); }
  }

  async function doVote(s) {
    if (!(await requireWallet())) return;
    if (chosenOption === null) return;
    const btn = $('gov-vote-btn');
    const err = $('gov-vote-error');
    const lock = toWei($('gov-lock')?.value);
    const idx = Array.from(selectedStakes).sort((a, b) => a - b); // contract requires ascending
    err.textContent = '';

    try {
      if (lock > 0n) {
        const allowance = BigInt(await read(() => tokenRead.methods.allowance(account, CONFIG.VOTING).call()));
        if (allowance < lock) {
          busy(btn, true, 'Approving…');
          await send(tokenWrite.methods.approve(CONFIG.VOTING, lock.toString()), CONFIG.TOKEN, 120000);
          notify('Approved. Confirm the vote next.');
        }
      }
      busy(btn, true, 'Voting…');
      await send(votingWrite.methods.vote(s.id, chosenOption, lock.toString(), idx, 0, ZERO32), CONFIG.VOTING, 800000);
      notify('Your vote is recorded.');
      // The RPC will serve pre-vote state for a few seconds; wait for the receipt.
      await settle(async () => {
        const r = await read(() => votingRead.methods.getReceipt(s.id, account).call());
        return r && r.voted;
      });
      chosenOption = null; selectedStakes.clear();
      await refresh();
      await renderDetail(s.id);
    } catch (e) {
      err.textContent = explain(e);
      notify(explain(e), 'error');
    } finally { busy(btn, false); }
  }

  /* ── Create ───────────────────────────────────────────────────────────── */

  function optionRows() { return Array.from(document.querySelectorAll('#gov-options .gov-input')); }

  function addOption(value = '') {
    const wrap = document.createElement('div');
    wrap.className = 'gov-option-row';
    wrap.innerHTML = `<div class="gov-input-wrap"><input type="text" class="gov-input" maxlength="64" placeholder="An option people can choose"></div>
                      <button type="button" class="gov-remove" aria-label="Remove option">&times;</button>`;
    wrap.querySelector('input').value = value;
    wrap.querySelector('input').addEventListener('input', updateCreateState);
    wrap.querySelector('.gov-remove').addEventListener('click', () => { wrap.remove(); updateCreateState(); });
    el['gov-options'].appendChild(wrap);
    updateCreateState();
  }

  function updateCreateState() {
    const title = el['gov-title'].value.trim();
    const opts = optionRows().map(i => i.value.trim());
    const filled = opts.filter(Boolean);
    const bytes = s => new TextEncoder().encode(s).length;

    el['gov-title-count'].textContent = `${bytes(title)}/256 bytes`;
    el['gov-options-count'].textContent = `${filled.length} of 2–100`;

    const dupes = filled.filter((v, i) => filled.indexOf(v) !== i);
    let problem = '';
    if (!title) problem = 'Add a question.';
    else if (bytes(title) > 256) problem = 'The question is too long.';
    else if (filled.length < 2) problem = 'Add at least two options.';
    else if (filled.length > 100) problem = 'That is more than 100 options.';
    else if (dupes.length) problem = `“${dupes[0]}” appears more than once — every option must be different.`;
    else if (filled.some(o => bytes(o) > 64)) problem = 'One option is longer than 64 characters.';

    const cidRaw = el['gov-cid'].value.trim();
    if (!problem && cidRaw) {
      const cid = parseCid(cidRaw);
      if (!cid) problem = 'That does not look like an IPFS link or CID.';
      else if (bytes(cid) > 100) problem = 'That IPFS link is too long to store on-chain.';
    }
    el['gov-cid-hint'].innerHTML = cidRaw
      ? (parseCid(cidRaw) ? `Will store <strong>${esc(parseCid(cidRaw))}</strong>` : 'Paste an IPFS CID or a gateway link.')
      : 'Paste an IPFS CID or a gateway link. No account needed — you can upload a document with <a href="https://files.fx.land/app" target="_blank" rel="noopener">FxFiles</a> and paste the link it gives you.';

    el['gov-options-hint'].textContent = dupes.length ? '' : 'Each option is stored as a fingerprint on-chain, so the choices cannot be changed later.';
    el['gov-create-error'].textContent = account ? (problem || '') : '';

    const btn = el['gov-create-btn'];
    if (!account) { btn.disabled = true; btn.textContent = 'Connect wallet to continue'; }
    else if (problem) { btn.disabled = true; btn.textContent = 'Raise proposal'; }
    else { btn.disabled = false; btn.textContent = 'Raise proposal'; }
  }

  function updateDuration() {
    const days = Number(el['gov-duration'].value);
    el['gov-duration-label'].textContent = days + (days === 1 ? ' day' : ' days');
    const minD = Number(params.minDuration || 0n) / 86400, maxD = Number(params.maxDuration || 0n) / 86400;
    el['gov-duration-hint'].textContent = `Between ${minD} and ${maxD} days. Voting closes automatically; tokens can be claimed after that.`;
  }

  async function doCreate() {
    if (!(await requireWallet())) return;
    const btn = el['gov-create-btn'];
    const title = el['gov-title'].value.trim();
    const cid = parseCid(el['gov-cid'].value.trim());
    const opts = optionRows().map(i => i.value.trim()).filter(Boolean);
    const seconds = Number(el['gov-duration'].value) * 86400;
    const need = (params.burnFee || 0n) + (params.deposit || 0n);

    try {
      const [bal, allowance] = await Promise.all([
        read(() => tokenRead.methods.balanceOf(account).call()),
        read(() => tokenRead.methods.allowance(account, CONFIG.VOTING).call())
      ]);
      if (BigInt(bal) < need) {
        el['gov-create-error'].textContent = `You need ${fula(need)} FULA to raise a proposal and have ${fula(bal)}.`;
        return;
      }
      // The fee is taken with burnFrom and the deposit with transferFrom — both draw on the SAME
      // allowance, so approving only the deposit fails. Approve the total in one go.
      if (BigInt(allowance) < need) {
        busy(btn, true, 'Approving…');
        await send(tokenWrite.methods.approve(CONFIG.VOTING, need.toString()), CONFIG.TOKEN, 120000);
        notify('Approved. Confirm the proposal next.');
      }
      busy(btn, true, 'Raising…');
      await send(votingWrite.methods.createSubject(title, cid, opts, seconds), CONFIG.VOTING, 1200000);
      notify('Your proposal is live.');
      el['gov-title'].value = ''; el['gov-cid'].value = '';
      el['gov-options'].innerHTML = ''; addOption(); addOption();
      await settle(async () => Number(await read(() => votingRead.methods.subjectCount().call())) > subjects.length);
      await refresh();
      switchTab('proposals');
    } catch (e) {
      el['gov-create-error'].textContent = explain(e);
      notify(explain(e), 'error');
    } finally { busy(btn, false); updateCreateState(); }
  }

  /* ── Admin ────────────────────────────────────────────────────────────── */

  function fmtParam(p, raw) {
    const v = BigInt(raw ?? 0);
    if (p.kind === 'token') return fula(v) + ' FULA';
    if (p.kind === 'days') return (Number(v) / 86400) + ' days';
    if (p.kind === 'bps') return (Number(v) / 10000).toFixed(2) + '×';
    return v.toString();
  }
  function parseParam(p, input) {
    const s = String(input ?? '').trim();
    if (!s || isNaN(Number(s))) return null;
    if (p.kind === 'token') return toWei(s);
    if (p.kind === 'days') return BigInt(Math.round(Number(s) * 86400));
    if (p.kind === 'bps') return BigInt(Math.round(Number(s) * 10000));
    return BigInt(Math.round(Number(s)));
  }

  async function loadAdmin() {
    const host = el['gov-admin-queue'];
    host.innerHTML = '<div class="gov-loading"><span class="gov-spinner"></span> Loading&hellip;</div>';
    try {
      const count = Number(await read(() => votingRead.methods.proposalCount().call()));
      const items = [];
      for (let i = 0; i < count; i++) {
        const pid = await read(() => votingRead.methods.proposalRegistry(i).call());
        if (!pid || pid === ZERO32) continue;
        const p = await read(() => votingRead.methods.proposals(pid).call());
        if (Number(p.config.status) !== 0 || p.target === ZERO) continue;
        const mine = account ? await read(() => votingRead.methods.hasProposalApproval(pid, account).call()) : false;
        items.push({ pid, p, mine });
      }
      if (!items.length) { host.innerHTML = '<div class="gov-empty"><p class="gov-empty__text">Nothing pending.</p></div>'; return; }

      host.innerHTML = items.map(({ pid, p, mine }) => {
        const t = Number(p.proposalType);
        const exec = Number(p.config.executionTime), exp = Number(p.config.expiryTime);
        const expired = chainNow >= exp, ready = chainNow >= exec && !expired;
        let what = `Proposal type ${t}`;
        if (t === PT_SET_PARAM) {
          const def = PARAMS.find(x => x.id === Number(p.id));
          what = def ? `Set “${def.label}” to ${fmtParam(def, p.amount)}` : `Set parameter ${p.id}`;
        } else if (t === PT_SET_INTEGRATION) {
          what = `Set ${Number(p.id) === 1 ? 'staking engine' : 'storage pool'} to ${shortAddr(p.tokenAddress)}`;
        }
        return `
          <article class="gov-card">
            <div class="gov-card__top">
              <h4 class="gov-card__title">${esc(what)}</h4>
              <span class="gov-pill gov-pill--${expired ? 'closed' : ready ? 'open' : 'finalized'}">${expired ? 'Expired' : ready ? 'Ready' : 'Waiting'}</span>
            </div>
            <div class="gov-card__meta">
              <span>${p.config.approvals}/2 approvals${mine ? ' — you approved' : ''}</span>
            </div>
            <p class="gov-window">Executable ${new Date(exec * 1000).toISOString().replace('T', ' ').slice(0, 16)} → ${new Date(exp * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC</p>
            <div class="gov-actions">
              ${!mine && !expired ? `<button class="btn btn--primary btn--sm" data-approve="${pid}">Approve</button>` : ''}
              ${ready && Number(p.config.approvals) >= 2 ? `<button class="btn btn--primary btn--sm" data-execute="${pid}">Execute</button>` : ''}
              ${expired ? `<button class="btn btn--outline btn--sm" data-cleanup="1">Clear expired</button>` : ''}
            </div>
          </article>`;
      }).join('');

      host.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', () =>
        txn(b, 'Approving…', () => votingWrite.methods.approveProposal(b.dataset.approve), 'Approved.').then(loadAdmin)));
      host.querySelectorAll('[data-execute]').forEach(b => b.addEventListener('click', () =>
        txn(b, 'Executing…', () => votingWrite.methods.executeProposal(b.dataset.execute), 'Change applied.').then(loadAdmin)));
      host.querySelectorAll('[data-cleanup]').forEach(b => b.addEventListener('click', () =>
        txn(b, 'Clearing…', () => votingWrite.methods.cleanupExpiredProposals(10), 'Expired changes cleared.').then(loadAdmin)));
    } catch (e) {
      host.innerHTML = `<div class="gov-empty"><p class="gov-empty__text">${esc(explain(e))}</p></div>`;
    }
  }

  function initAdminForms() {
    el['gov-param-select'].innerHTML = PARAMS.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
    const refresh = () => {
      const p = PARAMS.find(x => x.id === Number(el['gov-param-select'].value));
      if (!p) return;
      const b = bounds[p.key];
      el['gov-param-info'].textContent = `Currently ${fmtParam(p, params[p.key])}. Allowed between ${fmtParam(p, b?.[0])} and ${fmtParam(p, b?.[1])}.`;
      validateParam();
    };
    const validateParam = () => {
      const p = PARAMS.find(x => x.id === Number(el['gov-param-select'].value));
      const v = parseParam(p, el['gov-param-value'].value);
      const b = bounds[p.key];
      let msg = '';
      if (el['gov-param-value'].value.trim() === '') msg = '';
      else if (v === null) msg = 'Enter a number.';
      else if (b && (v < b[0] || v > b[1])) msg = `Must be between ${fmtParam(p, b[0])} and ${fmtParam(p, b[1])}.`;
      el['gov-param-error'].textContent = msg;
      el['gov-param-btn'].disabled = !!msg || v === null;
    };
    el['gov-param-select'].addEventListener('change', refresh);
    el['gov-param-value'].addEventListener('input', validateParam);
    el['gov-param-btn'].addEventListener('click', async b => {
      const p = PARAMS.find(x => x.id === Number(el['gov-param-select'].value));
      const v = parseParam(p, el['gov-param-value'].value);
      await txn(el['gov-param-btn'], 'Proposing…',
        () => votingWrite.methods.createProposal(PT_SET_PARAM, p.id, CONFIG.VOTING, ZERO32, v.toString(), ZERO),
        'Change proposed. Approve it now so only the execution needs the window.');
      loadAdmin();
    });
    refresh();

    const validateIntegration = () => {
      const v = el['gov-integration-value'].value.trim();
      const ok = v === '' || /^0x[0-9a-fA-F]{40}$/.test(v);
      el['gov-integration-error'].textContent = ok ? '' : 'That is not a valid address.';
      el['gov-integration-btn'].disabled = !ok || v === '';
    };
    el['gov-integration-value'].addEventListener('input', validateIntegration);
    el['gov-integration-btn'].addEventListener('click', async () => {
      const slot = Number(el['gov-integration-select'].value);
      const addr = el['gov-integration-value'].value.trim();
      await txn(el['gov-integration-btn'], 'Proposing…',
        () => votingWrite.methods.createProposal(PT_SET_INTEGRATION, slot, CONFIG.VOTING, ZERO32, 0, addr),
        'Change proposed. Approve it now so only the execution needs the window.');
      loadAdmin();
    });
    validateIntegration();
  }

  /* ── Tabs ─────────────────────────────────────────────────────────────── */

  function switchTab(name) {
    closeDetail();
    document.querySelectorAll('.gov-tabs__btn').forEach(b => {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    ['proposals', 'create', 'admin'].forEach(t => {
      const panel = $('tab-' + t);
      if (panel) panel.hidden = t !== name;
    });
    if (name === 'admin') loadAdmin();
  }

  /* ── Boot ─────────────────────────────────────────────────────────────── */

  async function refresh() {
    try {
      chainNow = Number(await read(() => readWeb3.eth.getBlock('latest').then(b => b.timestamp)));
    } catch (_) { chainNow = Math.floor(Date.now() / 1000); }
    subjects = await loadSubjects();
    renderList();
  }

  async function boot() {
    buildRead();

    el['gov-contract-line'].innerHTML =
      ` Voting contract: <a href="${CONFIG.EXPLORER}/address/${CONFIG.VOTING}" target="_blank" rel="noopener">${shortAddr(CONFIG.VOTING)}</a> on Base.`;

    // Wire the UI before any network call, so the page is usable even if RPCs are slow.
    el['gov-connect-btn'].addEventListener('click', () => { if (account) modal.disconnect(); else modal.open(); });
    el['gov-switch-btn'].addEventListener('click', ensureOnBase);
    el['gov-back-btn'].addEventListener('click', closeDetail);
    el['gov-filters'].addEventListener('click', e => {
      const chip = e.target.closest('.gov-chip'); if (!chip) return;
      filter = chip.dataset.filter;
      el['gov-filters'].querySelectorAll('.gov-chip').forEach(c => c.classList.toggle('active', c === chip));
      renderList();
    });
    document.querySelectorAll('.gov-tabs__btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    el['gov-title'].addEventListener('input', updateCreateState);
    el['gov-cid'].addEventListener('input', updateCreateState);
    el['gov-add-option'].addEventListener('click', () => addOption());
    el['gov-duration'].addEventListener('input', updateDuration);
    el['gov-create-btn'].addEventListener('click', doCreate);
    addOption(); addOption();

    try {
      await ensureHealthyRpc();
      await loadParams();
      // Read at runtime, never hardcoded: both are governable, and a hardcoded copy is
      // exactly how a wrong staking-engine address survives being fixed on-chain.
      engineAddress = await read(() => votingRead.methods.stakingEngine().call());
      el['gov-cost-fee'].textContent = fula(params.burnFee) + ' FULA';
      el['gov-cost-deposit'].textContent = fula(params.deposit) + ' FULA';
      el['gov-cost-total'].textContent = fula((params.burnFee || 0n) + (params.deposit || 0n)) + ' FULA';
      const minD = Number(params.minDuration) / 86400, maxD = Number(params.maxDuration) / 86400;
      el['gov-duration'].min = String(minD); el['gov-duration'].max = String(maxD);
      el['gov-duration'].value = String(Math.min(Math.max(7, minD), maxD));
      updateDuration(); updateCreateState();
      initAdminForms();
      await refresh();
    } catch (e) {
      el['gov-list-loading'].hidden = true;
      el['gov-list-error'].hidden = false;
      el['gov-list-error-text'].textContent = 'Base could not be reached just now. ' + explain(e);
    }

    try { await initWallet(); } catch (e) { console.warn('[governance] wallet init failed', e); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
