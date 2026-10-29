/*
 * memo-ai-key.js — optional personal API key for client-side AI (no server).
 *
 * Lets a user store their own OpenAI/Gemini/DeepSeek API key directly in this
 * browser/app, so photo analysis and chat keep working even with no sync
 * server configured (or when the server is temporarily unreachable). This is
 * a deliberately separate concept from the server's own AI Analysis settings
 * (memo-settings.js loadLlmConfig/handleSaveLlmConfig, /api/llm/config) — that
 * configures the *server's* key; this configures a key the client itself
 * uses to call providers directly (see memo-ai-client.js).
 *
 * Storage is plain localStorage — the same trust model as the sync password
 * (memo-auth.js). No keychain/encryption-at-rest: this is intentional, see
 * DISCLOSURE_TEXT below, which the Settings UI must show before saving a key.
 */
(function (global) {
  'use strict';

  var PROVIDER_KEY = 'memo_ai_key_provider';
  var ACK_KEY = 'memo_ai_key_disclosure_ack';
  function keyStorageKey(provider) { return 'memo_ai_key_' + provider; }

  // Who can read images (mirrors services/llm.py vision_capable): DeepSeek's
  // Flash models can, its Pro model cannot; a custom service is assumed not to.
  var VISION_PROVIDERS = { openai: true, gemini: true, deepseek: true, anthropic: true, custom: false };

  // Default models per provider (mirrors services/llm.py LLMService defaults).
  var MODELS = {
    openai: 'gpt-6-luna',
    gemini: 'gemini-3.8-flash',
    deepseek: 'deepseek-flash',
    anthropic: 'claude-sonnet-5-5'
  };

  var DISCLOSURE_TEXT =
    "Your API key will be stored in this browser's local storage, in plain text — " +
    "the same way the sync password is stored. It is not encrypted and not protected " +
    "by your device's keychain. Anyone with access to this browser/device could read it. " +
    "Only continue if you accept that risk and trust this device.";

  function getProvider() {
    try { return localStorage.getItem(PROVIDER_KEY) || ''; } catch (_e) { return ''; }
  }

  function setProvider(provider) {
    try {
      if (provider) localStorage.setItem(PROVIDER_KEY, provider);
      else localStorage.removeItem(PROVIDER_KEY);
    } catch (_e) { /* ignore quota / privacy mode */ }
    applyAvailability();
  }

  // Reflect whether AI is usable onto <body>: no key -> hide the chat entry
  // points (and skip the context-compacting pipeline, which is already gated on
  // isConfigured()). One body class covers memo/finance/planner via CSS.
  function applyAvailability() {
    try {
      if (typeof document !== 'undefined' && document.body) {
        document.body.classList.toggle('no-ai-key', !isConfigured());
      }
    } catch (_e) { /* ignore */ }
  }

  function getKey(provider) {
    if (!provider) return '';
    try { return localStorage.getItem(keyStorageKey(provider)) || ''; } catch (_e) { return ''; }
  }

  function setKey(provider, key) {
    if (!provider) return;
    try {
      if (key) localStorage.setItem(keyStorageKey(provider), key);
      else localStorage.removeItem(keyStorageKey(provider));
    } catch (_e) { /* ignore quota / privacy mode */ }
    applyAvailability();
  }

  // The key AI features use: the Vault's default AI key (its working copy
  // works while the Vault is locked), or a specific saved key by id. Keys from
  // older builds in plain localStorage still work until the Vault is first
  // unlocked, which moves them in and deletes the plain copies.
  function getActiveKey(id) {
    var vault = global.MemoVault && global.MemoVault.activeAiKey ? global.MemoVault.activeAiKey(id) : null;
    if (vault && vault.apiKey) {
      return { id: vault.id, provider: vault.provider, key: vault.apiKey, model: vault.model || MODELS[vault.provider] || null,
        baseUrl: vault.baseUrl || '', label: vault.label || '' };
    }
    var provider = getProvider();
    if (!provider) return null;
    var key = getKey(provider);
    if (!key) return null;
    return { provider: provider, key: key, model: MODELS[provider] || null };
  }

  function isConfigured() {
    return !!getActiveKey();
  }

  function supportsVision(provider, model) {
    provider = (provider || '').toLowerCase();
    if (provider === 'deepseek') return !model || /flash/i.test(model);
    return !!VISION_PROVIDERS[provider];
  }

  function hasAckedDisclosure() {
    try { return localStorage.getItem(ACK_KEY) === '1'; } catch (_e) { return false; }
  }

  function ackDisclosure() {
    try { localStorage.setItem(ACK_KEY, '1'); } catch (_e) { /* ignore */ }
  }

  // Full reset — clears the selected provider, every per-provider key slot,
  // and the disclosure ack (so re-enabling later re-prompts).
  function clearAll() {
    setProvider('');
    Object.keys(MODELS).forEach(function (p) { setKey(p, ''); });
    try { localStorage.removeItem(ACK_KEY); } catch (_e) { /* ignore */ }
    applyAvailability();
  }

  // Set the initial <body> state as soon as the DOM is ready.
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyAvailability);
    else applyAvailability();
  }

  global.MemoAiKey = {
    applyAvailability: applyAvailability,
    getProvider: getProvider,
    setProvider: setProvider,
    getKey: getKey,
    setKey: setKey,
    getActiveKey: getActiveKey,
    isConfigured: isConfigured,
    supportsVision: supportsVision,
    hasAckedDisclosure: hasAckedDisclosure,
    ackDisclosure: ackDisclosure,
    clearAll: clearAll,
    DISCLOSURE_TEXT: DISCLOSURE_TEXT,
    MODELS: MODELS
  };
})(window);
