/*
 * memo-ai-client.js — calls Gemini / DeepSeek / OpenAI / Claude / any
 * OpenAI-compatible service directly from the browser/app using the person's
 * own key from the Vault (memo-ai-key.js reads it), for use when no
 * sync server is configured (or as a fallback when one is unreachable).
 *
 * Ports the server-side prompts/parsing from services/llm.py (photo→entry
 * analysis) and services/chat_reply.py (simple chat) so results match what
 * the server would have produced. Transport goes through the existing
 * global.nativeFetch (memo-api.js), which is already Capacitor-safe and only
 * attaches the sync-password header to '/api/' URLs — safe to reuse as-is
 * for these external provider calls.
 */
(function (global) {
  'use strict';

  var BASE_URLS = {
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com'
  };
  var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

  // ---------------------------------------------------------------------
  // Prompts (ported verbatim from services/llm.py + backend_context.py)
  // ---------------------------------------------------------------------
  var ANALYZE_SYSTEM_PROMPT_DEFAULT =
    "You are an AI assistant that reads, transcribes, and analyses images and documents to create memo entries.\n" +
    "\n" +
    "When the image contains text (e.g. a certificate, letter, receipt, screenshot, note, sign, or printed document):\n" +
    "  - READ and TRANSCRIBE the actual text content verbatim as the description.\n" +
    "  - Do NOT describe the image visually (e.g. do not say \"a document showing a certificate\").\n" +
    "  - Include all key names, titles, dates, and sentences found in the text.\n" +
    "\n" +
    "When the image is purely visual with no meaningful text (e.g. a photo, diagram, or drawing):\n" +
    "  - Provide a clear factual description of what is depicted.\n" +
    "\n" +
    "Extract the following fields:\n" +
    "- description: The full transcribed text or factual description of the content (be specific and complete)\n" +
    "- category: Appropriate category (e.g. 'Certificate', 'Award', 'Work', 'Personal', 'Reference', 'Project', etc.)\n" +
    "- tags: Relevant keywords derived from the actual content (array of strings)\n" +
    "\n" +
    "Return ONLY a valid JSON object with these exact keys:\n" +
    "{\n" +
    '  "description": "Transcribed text or factual description",\n' +
    '  "category": "Category name",\n' +
    '  "tags": ["tag1", "tag2"]\n' +
    "}\n" +
    "\n" +
    "If you cannot determine values, use:\n" +
    "- description: Brief factual description of what you see\n" +
    "- category: \"Uncategorized\"\n" +
    "- tags: []";

  var ANALYZE_SYSTEM_PROMPT_FINANCE =
    "You are an AI assistant that analyzes receipts, invoices, and financial documents.\n" +
    "Extract the following information from the image/file:\n" +
    "- description: Brief summary of the purchase or transaction\n" +
    "- category: Category like 'Groceries', 'Electronics', 'Dining', 'Transportation', 'Entertainment', etc.\n" +
    "- tags: Relevant keywords (array of strings)\n" +
    "- purchaseDate: Date in YYYY-MM-DD format\n" +
    "- price: Subtotal amount before tax (number, 0 if unknown)\n" +
    "- tax: Tax amount in dollars as written in the document (number, 0 if unknown)\n" +
    "- total: Final total amount (number, 0 if unknown)\n" +
    "- items: Array of individual line items extracted verbatim from the document (empty array [] if none found).\n" +
    '  Each item must have: {"name": "item name", "description": "extra detail or empty string", "amount": 1, "unitPrice": 0.00, "totalPrice": 0.00}\n' +
    "\n" +
    "Return ONLY a valid JSON object with these exact keys. Defaults if a value cannot be determined:\n" +
    "- description: \"Receipt/invoice\"\n" +
    "- category: \"Uncategorized\"\n" +
    "- tags: []\n" +
    "- purchaseDate: Today's date\n" +
    "- price: 0\n" +
    "- tax: 0\n" +
    "- total: 0\n" +
    "- items: []\n" +
    "\n" +
    "Example output:\n" +
    "{\n" +
    '  "description": "Grocery shopping at Whole Foods",\n' +
    '  "category": "Groceries",\n' +
    '  "tags": ["food", "organic"],\n' +
    '  "purchaseDate": "2025-01-15",\n' +
    '  "price": 45.50,\n' +
    '  "tax": 3.64,\n' +
    '  "total": 49.14,\n' +
    '  "items": [\n' +
    '    {"name": "Organic Apples", "description": "", "amount": 2, "unitPrice": 3.99, "totalPrice": 7.98},\n' +
    '    {"name": "Whole Milk", "description": "1 gallon", "amount": 1, "unitPrice": 4.49, "totalPrice": 4.49}\n' +
    "  ]\n" +
    "}";

  var SIMPLE_CHAT_SYSTEM_PROMPT =
    'You are an efficient assistant embedded in a personal memo system.' +
    ' You will be provide with a list of their memos.' +
    ' Sometimes the user may not provide the full context of their questions, make an educated guess.' +
    ' Sometimes what the user ask may not match exactly what is in the memos, try to find the closest match.' +
    ' Provide concise, helpful answers. If user asks to reference memos, you can reason over the conversation context only;' +
    ' you cannot actually read files unless explicitly given their content.';

  function buildAnalyzeSystemPrompt(variant) {
    return variant === 'finance' ? ANALYZE_SYSTEM_PROMPT_FINANCE : ANALYZE_SYSTEM_PROMPT_DEFAULT;
  }

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function (err) { reject(err); };
      reader.readAsDataURL(file);
    });
  }

  function splitDataUrl(dataUrl) {
    var m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
    return m ? { mimeType: m[1], data: m[2] } : { mimeType: 'application/octet-stream', data: '' };
  }

  async function safeJson(resp) {
    try { return await resp.json(); } catch (_e) { return null; }
  }

  function describeProviderError(provider, status, data) {
    var msg = (data && data.error && (data.error.message || data.error)) ||
      (data && data.message) || ('HTTP ' + status);
    return provider + ' error (' + status + '): ' + msg;
  }

  function toFloat(val, fallback) {
    var n = parseFloat(val);
    return isNaN(n) ? fallback : n;
  }

  function toInt(val, fallback) {
    var n = parseInt(val, 10);
    return isNaN(n) ? fallback : n;
  }

  // ---------------------------------------------------------------------
  // Response parsing (ports services/llm.py _parse_llm_response / _get_default_entry_data)
  // ---------------------------------------------------------------------
  function stripCodeFences(responseText) {
    var text = (responseText || '').trim();
    if (text.indexOf('```') === 0) {
      var lines = text.split('\n');
      text = (lines.length > 2) ? lines.slice(1, -1).join('\n') : text;
      if (text.indexOf('json') === 0) text = text.slice(4).trim();
    }
    return text;
  }

  function defaultEntryData(variant) {
    var result = {
      description: 'File uploaded - LLM analysis pending',
      category: 'Uncategorized',
      tags: ['needs-review']
    };
    if (variant === 'finance') {
      result.purchaseDate = '';
      result.price = 0;
      result.tax = 0;
      result.total = 0;
      result.adjustment = 0;
      result.items = [];
    }
    return result;
  }

  function parseAnalyzeResponse(responseText, variant) {
    try {
      var text = stripCodeFences(responseText);
      var data = JSON.parse(text);
      var result = {
        description: data.description || 'Analyzed content',
        category: data.category || 'Uncategorized',
        tags: Array.isArray(data.tags) ? data.tags : []
      };
      if (variant === 'finance') {
        result.purchaseDate = data.purchaseDate || '';
        result.price = toFloat(data.price, 0);
        result.tax = toFloat(data.tax, 0);
        result.total = toFloat(data.total, 0);
        result.adjustment = toFloat(data.adjustment, 0);
        var rawItems = Array.isArray(data.items) ? data.items : [];
        result.items = rawItems
          .filter(function (it) { return it && typeof it === 'object'; })
          .map(function (it) {
            return {
              name: String(it.name || ''),
              description: String(it.description || ''),
              amount: toInt(it.amount, 1),
              unitPrice: toFloat(it.unitPrice, 0),
              totalPrice: toFloat(it.totalPrice, 0)
            };
          });
      }
      return result;
    } catch (e) {
      console.warn('[MemoAiClient] Failed to parse LLM response as JSON:', e, responseText);
      return defaultEntryData(variant);
    }
  }

  // ---------------------------------------------------------------------
  // Provider transport
  // ---------------------------------------------------------------------
  function fetchFn(url, opts) {
    return (typeof global.nativeFetch === 'function') ? global.nativeFetch(url, opts) : fetch(url, opts);
  }

  // OpenAI's reasoning models (o-series, GPT-5 and later) reject temperature
  // and max_tokens; on Chat Completions they call tools only with
  // reasoning_effort "none". Older models, DeepSeek and custom services keep
  // the classic parameters.
  function openAiReasoning(model) { return /^(o\d|gpt-[5-9])/i.test(String(model || '')); }
  function sampling(model, opts) {
    var out = {};
    if (openAiReasoning(model)) { if (opts && opts.maxTokens) out.max_completion_tokens = opts.maxTokens; return out; }
    out.temperature = (opts && opts.temperature != null) ? opts.temperature : 0.7;
    if (opts && opts.maxTokens) out.max_tokens = opts.maxTokens;
    return out;
  }

  async function callOpenAiCompatible(baseUrl, apiKey, model, messages, opts) {
    var body = Object.assign({ model: model, messages: messages }, sampling(model, opts));

    var resp = await fetchFn(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(body)
    });
    var data = await safeJson(resp);
    if (!resp.ok) throw new Error(describeProviderError('openai', resp.status, data));
    return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }

  async function callGemini(apiKey, model, systemPrompt, contents, generationConfig) {
    var url = GEMINI_BASE + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
    var body = { contents: contents, generationConfig: generationConfig || {} };
    if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };

    var resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var data = await safeJson(resp);
    if (!resp.ok) throw new Error(describeProviderError('gemini', resp.status, data));
    var cand = data && data.candidates && data.candidates[0];
    var parts = (cand && cand.content && cand.content.parts) || [];
    return parts.map(function (p) { return p.text || ''; }).join('');
  }

  // Claude goes through the official Anthropic SDK (vendored browser build,
  // loaded on first use). On the phone CapacitorHttp patches fetch, so the
  // SDK's requests are native there too.
  var anthropicSdk = null;
  function loadAnthropicSdk() {
    if (global.MemoAnthropicSdk) return Promise.resolve(global.MemoAnthropicSdk);
    if (!anthropicSdk) {
      anthropicSdk = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = '/static/vendor/anthropic-sdk.js';
        s.onload = function () { global.MemoAnthropicSdk ? resolve(global.MemoAnthropicSdk) : reject(new Error('Claude support failed to load.')); };
        s.onerror = function () { anthropicSdk = null; reject(new Error('Claude support failed to load.')); };
        document.head.appendChild(s);
      });
    }
    return anthropicSdk;
  }
  // Models that take the server-side refusal fallback ("default" routes by
  // refusal category, so no model list to maintain).
  var CLAUDE_FALLBACK_MODELS = { 'claude-fable-5-1': true, 'claude-opus-5-5': true, 'claude-opus-5': true, 'claude-sonnet-5-5': true };

  // One Messages API request with readable errors.
  async function anthropicCreate(apiKey, params) {
    var sdk = await loadAnthropicSdk();
    // The person's own key, used from their own device.
    var client = new sdk.Anthropic({ apiKey: apiKey, dangerouslyAllowBrowser: true });
    var response;
    try {
      response = CLAUDE_FALLBACK_MODELS[params.model]
        ? await client.beta.messages.create(Object.assign({}, params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }))
        : await client.messages.create(params);
    } catch (error) {
      if (error instanceof sdk.Anthropic.AuthenticationError) throw new Error('Claude rejected this API key. Check it in the Vault.');
      if (error instanceof sdk.Anthropic.RateLimitError) throw new Error('Claude is rate limiting this key. Try again in a moment.');
      if (error instanceof sdk.Anthropic.APIConnectionError) throw new Error('Could not reach Claude. Check the connection.');
      if (error instanceof sdk.Anthropic.APIError) throw new Error(describeProviderError('Claude', error.status || 0, error.error || { message: error.message }));
      throw error;
    }
    if (response.stop_reason === 'refusal') throw new Error('Claude declined to answer this one.');
    return response;
  }
  function claudeText(response) {
    return (response.content || []).map(function (block) { return block && block.type === 'text' ? block.text : ''; }).join('');
  }

  async function callAnthropic(apiKey, model, systemPrompt, messages) {
    // No sampling parameters: current Claude models reject temperature. Room
    // for adaptive thinking, which is on by default.
    var params = { model: model, max_tokens: 16000, messages: messages };
    if (systemPrompt) params.system = systemPrompt;
    return claudeText(await anthropicCreate(apiKey, params));
  }

  function baseUrlFor(active) {
    if (active.provider === 'custom') return String(active.baseUrl || '').replace(/\/+$/, '');
    return BASE_URLS[active.provider];
  }

  // ---------------------------------------------------------------------
  // Turns → each provider's message shape
  // ---------------------------------------------------------------------
  function cleanTurns(messages) {
    var turns = (messages || []).filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && m.content != null; });
    if (!turns.length || turns[turns.length - 1].role !== 'user') turns.push({ role: 'user', content: '' });
    return turns;
  }
  function openAiMessages(systemPrompt, turns, images) {
    var msgs = [], last = turns.length - 1;
    if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
    turns.forEach(function (m, i) {
      if (i === last && images.length) {
        msgs.push({ role: 'user', content: [{ type: 'text', text: String(m.content) }].concat(images.map(function (url) { return { type: 'image_url', image_url: { url: url } }; })) });
      } else msgs.push({ role: m.role, content: String(m.content).slice(0, 8000) });
    });
    return msgs;
  }
  function geminiContents(turns, images) {
    var last = turns.length - 1;
    return turns.map(function (m, i) {
      var parts = [{ text: String(m.content) || ' ' }];
      if (i === last) images.forEach(function (url) { var d = splitDataUrl(url); parts.push({ inlineData: { mimeType: d.mimeType, data: d.data } }); });
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: parts };
    });
  }
  // Claude wants alternating turns that start with the user.
  function claudeMessages(turns, images) {
    var alt = [];
    turns.forEach(function (m) {
      if (!alt.length && m.role !== 'user') return;
      if (alt.length && alt[alt.length - 1].role === m.role) alt[alt.length - 1].text += '\n\n' + m.content;
      else alt.push({ role: m.role, text: String(m.content) });
    });
    return alt.map(function (m, i) {
      if (i === alt.length - 1 && m.role === 'user' && images.length) {
        return { role: 'user', content: images.map(function (url) { var d = splitDataUrl(url); return { type: 'image', source: { type: 'base64', media_type: d.mimeType, data: d.data } }; })
          .concat([{ type: 'text', text: m.text || ' ' }]) };
      }
      return { role: m.role, content: m.text || ' ' };
    });
  }
  function isOpenAiFamily(provider) { return provider === 'openai' || provider === 'deepseek' || provider === 'custom'; }

  // One request to whichever provider the key belongs to.
  //   messages: [{ role: 'user'|'assistant', content: text }]
  //   opts.images: data URLs attached to the last user message
  async function complete(active, systemPrompt, messages, opts) {
    opts = opts || {};
    var images = opts.images || [];
    var provider = active.provider;
    var turns = cleanTurns(messages);
    if (isOpenAiFamily(provider)) return callOpenAiCompatible(baseUrlFor(active), active.key, active.model, openAiMessages(systemPrompt, turns, images), opts);
    if (provider === 'gemini') return callGemini(active.key, active.model, systemPrompt, geminiContents(turns, images), opts.temperature != null ? { temperature: opts.temperature } : {});
    if (provider === 'anthropic') return callAnthropic(active.key, active.model, systemPrompt, claudeMessages(turns, images));
    throw new Error('Unsupported provider: ' + provider);
  }

  // ---------------------------------------------------------------------
  // Tool use: the model may call tools for up to opts.maxSteps rounds, then
  // must answer. Tools are neutral specs { name, description, parameters }
  // (JSON schema); opts.exec(name, args) runs one and returns a JSON-able
  // result. Each provider's assistant turn goes back exactly as it came, so
  // thinking blocks and signatures survive. active.provider 'server' sends
  // each step to the sync server's own AI (/api/ai/step).
  // ---------------------------------------------------------------------
  function parseArgs(text) {
    try { var v = JSON.parse(text || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (_e) { return {}; }
  }
  function geminiSchema(schema) {
    if (Array.isArray(schema)) return schema.map(geminiSchema);
    if (!schema || typeof schema !== 'object') return schema;
    var out = {};
    Object.keys(schema).forEach(function (k) {
      var v = schema[k];
      if (k === 'type' && typeof v === 'string') out.type = v.toUpperCase();
      else if (k === 'properties') { out.properties = {}; Object.keys(v).forEach(function (n) { out.properties[n] = geminiSchema(v[n]); }); }
      else if (k === 'items') out.items = geminiSchema(v);
      else if (['description', 'enum', 'required', 'format', 'nullable'].indexOf(k) >= 0) out[k] = v;
    });
    return out;
  }

  var TOOL_ADAPTERS = {
    openai: {
      start: function (active, system, turns, images, tools) {
        return { active: active, msgs: openAiMessages(system, turns, images), tools: tools.map(function (t) { return { type: 'function', function: t }; }) };
      },
      step: async function (st, final) {
        var body = { model: st.active.model, messages: st.msgs };
        if (!final && st.tools.length) {
          body.tools = st.tools;
          if (openAiReasoning(st.active.model)) body.reasoning_effort = 'none';
        }
        var resp = await fetchFn(baseUrlFor(st.active) + '/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + st.active.key }, body: JSON.stringify(body)
        });
        var data = await safeJson(resp);
        if (!resp.ok) throw new Error(describeProviderError(st.active.provider, resp.status, data));
        var m = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
        var raw = { role: 'assistant', content: m.content || '' };
        if (m.tool_calls && m.tool_calls.length) raw.tool_calls = m.tool_calls;
        if (m.reasoning_content) raw.reasoning_content = m.reasoning_content;   // DeepSeek thinking mode wants it back
        return { text: m.content || '', raw: raw, calls: (m.tool_calls || []).map(function (tc) {
          return { id: tc.id, name: tc.function && tc.function.name, args: parseArgs(tc.function && tc.function.arguments) };
        }) };
      },
      push: function (st, out, results) {
        st.msgs.push(out.raw);
        results.forEach(function (r) { st.msgs.push({ role: 'tool', tool_call_id: r.call.id, content: JSON.stringify(r.result) }); });
      }
    },
    gemini: {
      start: function (active, system, turns, images, tools) {
        return { active: active, system: system, contents: geminiContents(turns, images),
          tools: tools.length ? [{ functionDeclarations: tools.map(function (t) { return { name: t.name, description: t.description, parameters: geminiSchema(t.parameters) }; }) }] : null };
      },
      step: async function (st, final) {
        var body = { contents: st.contents };
        if (st.system) body.systemInstruction = { parts: [{ text: st.system }] };
        if (st.tools) { body.tools = st.tools; if (final) body.toolConfig = { functionCallingConfig: { mode: 'NONE' } }; }
        var resp = await fetchFn(GEMINI_BASE + encodeURIComponent(st.active.model) + ':generateContent?key=' + encodeURIComponent(st.active.key), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        var data = await safeJson(resp);
        if (!resp.ok) throw new Error(describeProviderError('gemini', resp.status, data));
        var content = (data && data.candidates && data.candidates[0] && data.candidates[0].content) || { role: 'model', parts: [] };
        if (!content.role) content.role = 'model';
        var text = '', calls = [];
        (content.parts || []).forEach(function (p, i) {
          if (p.functionCall) calls.push({ id: p.functionCall.id || 'gem_' + i, name: p.functionCall.name, args: p.functionCall.args || {}, geminiId: p.functionCall.id });
          else if (p.text && !p.thought) text += p.text;
        });
        return { text: text, calls: calls, raw: content };
      },
      push: function (st, out, results) {
        st.contents.push(out.raw);
        st.contents.push({ role: 'user', parts: results.map(function (r) {
          var response = { name: r.call.name, response: r.result && typeof r.result === 'object' && !Array.isArray(r.result) ? r.result : { result: r.result } };
          if (r.call.geminiId) response.id = r.call.geminiId;
          return { functionResponse: response };
        }) });
      }
    },
    anthropic: {
      start: function (active, system, turns, images, tools) {
        return { active: active, system: system, msgs: claudeMessages(turns, images),
          tools: tools.map(function (t) { return { name: t.name, description: t.description, input_schema: t.parameters }; }) };
      },
      step: async function (st, final) {
        var params = { model: st.active.model, max_tokens: 16000, messages: st.msgs };
        if (st.system) params.system = st.system;
        if (st.tools.length) { params.tools = st.tools; if (final) params.tool_choice = { type: 'none' }; }
        var response = await anthropicCreate(st.active.key, params);
        return { text: claudeText(response), raw: response.content, calls: (response.content || []).filter(function (b) { return b && b.type === 'tool_use'; })
          .map(function (b) { return { id: b.id, name: b.name, args: b.input && typeof b.input === 'object' ? b.input : {} }; }) };
      },
      push: function (st, out, results) {
        st.msgs.push({ role: 'assistant', content: out.raw });
        st.msgs.push({ role: 'user', content: results.map(function (r) {
          return { type: 'tool_result', tool_use_id: r.call.id, content: JSON.stringify(r.result), is_error: !!(r.result && r.result.error) };
        }) });
      }
    },
    server: {
      start: function (active, system, turns, images, tools) {
        var msgs = turns.map(function (m) { return { role: m.role, content: String(m.content) }; });
        if (images.length) msgs[msgs.length - 1].images = images;
        return { active: active, system: system, msgs: msgs, tools: tools };
      },
      step: async function (st, final) {
        var base = String(st.active.apiBase || '').replace(/\/$/, '');
        var resp = await fetchFn(base + '/api/ai/step', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ system: st.system, messages: st.msgs, tools: st.tools, final: !!final })
        });
        var data = await safeJson(resp);
        if (!resp.ok) throw new Error((data && data.message) || ('Your server’s AI failed (HTTP ' + resp.status + ').'));
        return { text: data.text || '', raw: data.raw || null, calls: (data.calls || []).map(function (c) { return { id: c.id, name: c.name, args: c.args || {} }; }) };
      },
      push: function (st, out, results) {
        st.msgs.push({ role: 'assistant', content: out.text, calls: out.calls, raw: out.raw });
        results.forEach(function (r) { st.msgs.push({ role: 'tool', id: r.call.id, name: r.call.name, result: r.result }); });
      }
    }
  };

  async function runTools(active, systemPrompt, messages, opts) {
    opts = opts || {};
    var tools = opts.tools || [], maxSteps = opts.maxSteps == null ? 5 : opts.maxSteps;
    var adapter = TOOL_ADAPTERS[isOpenAiFamily(active.provider) ? 'openai' : active.provider];
    if (!adapter) throw new Error('Unsupported provider: ' + active.provider);
    var st = adapter.start(active, systemPrompt, cleanTurns(messages), opts.images || [], tools);
    var text = '';
    for (var step = 0; ; step++) {
      var final = !tools.length || step >= maxSteps;
      var out = await adapter.step(st, final);
      if (out.text) text = out.text;
      if (final || !out.calls.length) return { text: (out.text || text || '').trim(), steps: step };
      var results = [];
      for (var i = 0; i < out.calls.length; i++) {
        var call = out.calls[i], result;
        try { result = await opts.exec(call.name, call.args || {}); }
        catch (error) { result = { error: (error && error.message) || String(error) }; }
        results.push({ call: call, result: result == null ? { ok: true } : result });
      }
      adapter.push(st, out, results);
    }
  }

  function requireKey(keyId) {
    var active = global.MemoAiKey && global.MemoAiKey.getActiveKey(keyId);
    if (!active) throw new Error('No AI key yet. Add one in the Vault, under AI keys.');
    return active;
  }

  // ---------------------------------------------------------------------
  // Public: photo/file -> draft entry (ports services/llm.py analyze_files_for_entry)
  // ---------------------------------------------------------------------
  async function analyzeImages(files, userMessage, variant) {
    var active = requireKey();
    if (!global.MemoAiKey.supportsVision(active.provider, active.model)) {
      throw new Error('This AI key is chat-only and cannot read photos. Make a DeepSeek Flash, Gemini, OpenAI or Claude key the default in the Vault, or use a connected server with OCR.');
    }
    var images = (files || []).filter(function (f) { return f && f.type && f.type.indexOf('image/') === 0; });
    if (!images.length) return defaultEntryData(variant);
    var urls = [];
    for (var i = 0; i < images.length; i++) urls.push(await fileToBase64(images[i]));
    var userPrompt = userMessage || 'Analyze the uploaded file(s) and extract relevant information.';
    var resultText = await complete(active, buildAnalyzeSystemPrompt(variant), [{ role: 'user', content: userPrompt }],
      { images: urls, maxTokens: 2000, temperature: 0.3 });
    return parseAnalyzeResponse(resultText, variant);
  }

  // ---------------------------------------------------------------------
  // Public: simple chat (ports services/chat_reply.py generate_llm_reply)
  //   opts.keyId: a specific saved key (an AI contact's); opts.model: that
  //   contact's model instead of the key's; opts.system: a whole system
  //   prompt in place of the default one.
  // ---------------------------------------------------------------------
  async function chat(historyMessages, latestUserText, entriesSummaryText, opts) {
    opts = opts || {};
    var active = requireKey(opts.keyId);
    if (opts.model) active = Object.assign({}, active, { model: opts.model });
    var systemPrompt = opts.system || SIMPLE_CHAT_SYSTEM_PROMPT;
    if (entriesSummaryText) systemPrompt += '\n\nUser-selected context entries:\n' + entriesSummaryText;
    var turns = (historyMessages || []).filter(Boolean).map(function (m) { return { role: m.role, content: String(m.content || '').slice(0, 4000) }; });
    if (latestUserText) turns.push({ role: 'user', content: String(latestUserText).slice(0, 4000) });
    var text = await complete(active, systemPrompt, turns, { temperature: 0.7, maxTokens: opts.maxTokens || 1500 });
    return (text || '(No response)').trim();
  }

  // ---------------------------------------------------------------------
  // Public: entries -> plain-text context summary (ports chat_reply.py _build_entries_summary)
  // ---------------------------------------------------------------------
  function buildEntriesSummary(entries, variant) {
    var subset = (entries || []).slice(0, 60);
    var lines = subset.map(function (entry) {
      var desc = String(entry.description || '').replace(/\n/g, ' ').slice(0, 160);
      var tags = Array.isArray(entry.tags) ? entry.tags.join(',') : '';
      var category = entry.category || 'Uncategorized';
      if (variant === 'finance') {
        return 'ID=' + entry.id + ' | date=' + (entry.purchaseDate || '') + ' | category=' + category +
          ' | price=' + entry.price + ' tax=' + entry.tax + ' adj=' + entry.adjustment + ' total=' + entry.total +
          ' | tags=' + tags + " | desc='" + desc + "'";
      }
      return 'ID=' + entry.id + ' | date=' + entry.createdAt + ' | ts=' + entry.ts + ' | category=' + category +
        ' | tags=' + tags + " | desc='" + desc + "'";
    });
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------
  // Public: CORS feasibility probe — deliberately-invalid key, interpret the
  // failure mode. A parsed (non-2xx) JSON error means CORS let the request
  // through; a thrown network-level error means it was blocked.
  // ---------------------------------------------------------------------
  async function probeCors(provider) {
    try {
      if (provider === 'openai' || provider === 'deepseek') {
        var baseUrl = provider === 'openai' ? BASE_URLS.openai : BASE_URLS.deepseek;
        var resp = await fetchFn(baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer probe-invalid-key' },
          body: JSON.stringify({ model: provider === 'openai' ? 'gpt-4o-mini' : 'deepseek-flash', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
        });
        await safeJson(resp);
        return { ok: true, blocked: false, status: resp.status };
      }
      if (provider === 'gemini') {
        var url = GEMINI_BASE + 'gemini-3.8-flash:generateContent?key=probe-invalid-key';
        var r = await fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] })
        });
        await safeJson(r);
        return { ok: true, blocked: false, status: r.status };
      }
      return { ok: false, blocked: false, error: 'Unknown provider: ' + provider };
    } catch (err) {
      return { ok: false, blocked: true, error: (err && err.message) || String(err) };
    }
  }

  global.MemoAiClient = {
    analyzeImages: analyzeImages,
    chat: chat,
    complete: function (systemPrompt, messages, opts) { return complete(requireKey(opts && opts.keyId), systemPrompt, messages, opts); },
    // active: a key from MemoAiKey.getActiveKey, or { provider: 'server', apiBase }.
    runTools: runTools,
    buildEntriesSummary: buildEntriesSummary,
    probeCors: probeCors,
    _parseAnalyzeResponse: parseAnalyzeResponse,
    _defaultEntryData: defaultEntryData
  };
})(window);
