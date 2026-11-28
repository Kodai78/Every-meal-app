(() => {
  'use strict';

  // ================= 定数・設定 =================
  const STORAGE_KEY = 'meal_planner_split_v1';
  const API_KEY_STORAGE = 'meal_planner_gemini_key';
  const MODEL_CACHE_STORAGE = 'meal_planner_gemini_model_v4';
  const FALLBACK_MODELS = [
    'gemini-flash-latest',
    'gemini-2.5-flash-lite',
    'gemini-3-flash-preview'
  ];

  const WEEKDAYS = [
    { key: 'mon', label: '月', full: '月曜日' },
    { key: 'tue', label: '火', full: '火曜日' },
    { key: 'wed', label: '水', full: '水曜日' },
    { key: 'thu', label: '木', full: '木曜日' },
    { key: 'fri', label: '金', full: '金曜日' },
    { key: 'sat', label: '土', full: '土曜日' },
    { key: 'sun', label: '日', full: '日曜日' }
  ];

  const TIMINGS = [
    { key: 'breakfast', label: '🌅 朝食' },
    { key: 'lunch', label: '☀️ 昼食' },
    { key: 'dinner', label: '🌙 夕食' },
    { key: 'snack', label: '☕ 間食・その他' }
  ];

  // カロリー・栄養価算出の共通ルール（検索情報＋日本食品標準成分表ベース）
  const NUTRITION_SYSTEM_RULE = [
    'あなたは日本の食事・外食・栄養価に詳しい管理栄養士です。',
    '外食チェーン（サイゼリヤ、吉野家、マック等）・コンビニ商品・ラーメン（二郎系ラーメン等）・一般的な家庭料理について、公式栄養成分や一般的な1人前の実態データ、および文部科学省「日本食品標準成分表（八訂）」を基準に現実的で納得感のある大まかなカロリー(kcal)とPFC(g)を算出してください。',
    '料理名に分量指定がない場合は、日本で一般的な1人前（例：ラーメン二郎・全マシなら麺300g・ブタ2枚・ヤサイマシ・アブラマシ想定など）を基準にし、何を想定したかをメモに簡潔に記載してください。'
  ].join('\n');

  // ================= 状態管理 =================
  const defaultState = () => ({
    profile: {
      weight: 65.0,
      height: 170.0,
      age: 30,
      gender: 'male',
      activity: 1.55,
      goalOffset: 0,
      useManualTarget: false,
      manualTarget: 2000,
      dinnerRatio: 40
    },
    pantry: [],
    weeklyMenu: WEEKDAYS.reduce((acc, d) => {
      acc[d.key] = { name: '', ingredients: '', calories: 0, p: 0, f: 0, c: 0, breakdown: [], excluded: false };
      return acc;
    }, {}),
    dailyLogs: {}, // { 'YYYY-MM-DD': [ { id, timing, name, calories, p, f, c, breakdown, photo, fromMenuDay } ] }
    weightHistory: [] // [ { date: 'YYYY-MM-DD', weight: 65.0 } ]
  });

  let state = loadState();
  let selectedDateStr = formatDate(new Date());
  let historyRange = 7;
  let currentMealDraftPhoto = '';
  let currentMealDraftBreakdown = [];
  let currentMealDraftNote = '';
  let editingDinnerDayKey = 'mon';
  let aiMenuDaySelection = {};
  let pendingReceiptItems = [];

  // ================= 日付ユーティリティ =================
  function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function getCurrentWeekMap() {
    const today = new Date();
    const jsDay = today.getDay(); // 0=Sun, 1=Mon...
    const diffToMon = jsDay === 0 ? -6 : 1 - jsDay;
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + diffToMon);
    return WEEKDAYS.map((wd, idx) => {
      const dt = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + idx);
      return {
        ...wd,
        dateStr: formatDate(dt),
        dayNum: dt.getDate(),
        monthDay: `${dt.getMonth() + 1}/${dt.getDate()}`
      };
    });
  }

  function findDayInfoByDate(dateStr) {
    const week = getCurrentWeekMap();
    return week.find(w => w.dateStr === dateStr) || null;
  }

  // ================= 保存・読み込み =================
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const base = defaultState();
      return {
        ...base,
        ...parsed,
        profile: { ...base.profile, ...(parsed.profile || {}) },
        weeklyMenu: { ...base.weeklyMenu, ...(parsed.weeklyMenu || {}) },
        dailyLogs: parsed.dailyLogs || {},
        pantry: Array.isArray(parsed.pantry) ? parsed.pantry : [],
        weightHistory: Array.isArray(parsed.weightHistory) ? parsed.weightHistory : []
      };
    } catch {
      return defaultState();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      const dates = Object.keys(state.dailyLogs).sort();
      for (const dt of dates) {
        for (const item of state.dailyLogs[dt]) {
          if (item.photo) {
            item.photo = '';
            try {
              localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
              return;
            } catch { /* 続行 */ }
          }
        }
      }
    }
  }

  // ================= カロリー＆PFC計算 =================
  function calcMetrics() {
    const p = state.profile;
    const base = 10 * p.weight + 6.25 * p.height - 5 * p.age;
    const bmr = Math.round(p.gender === 'male' ? base + 5 : base - 161);
    const tdee = Math.round(bmr * p.activity);
    const autoTarget = Math.max(1200, tdee + Number(p.goalOffset));
    const target = p.useManualTarget ? Math.max(1000, Number(p.manualTarget) || autoTarget) : autoTarget;
    const targetP = Math.round((target * 0.2) / 4);
    const targetF = Math.round((target * 0.25) / 9);
    const targetC = Math.round((target * 0.55) / 4);
    const dinnerGuide = Math.round((target * (p.dinnerRatio || 40)) / 100);
    return { bmr, tdee, target, targetP, targetF, targetC, dinnerGuide };
  }

  // ================= UI ヘルパー =================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let toastTimer = null;
  function showToast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  function setLoading(show, text = 'AIがカロリー計算中...') {
    $('#loading-text').textContent = text;
    $('#loading-overlay').classList.toggle('hidden', !show);
  }

  function openModal(id) { $(`#${id}`).classList.remove('hidden'); }
  function closeModal(id) { $(`#${id}`).classList.add('hidden'); }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function openEiyouKeisan(keyword = '') {
    const q = keyword.trim();
    const url = q
      ? `https://www.google.com/search?q=${encodeURIComponent('site:eiyoukeisan.com ' + q)}`
      : 'https://www.eiyoukeisan.com/';
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  // ================= 画像リサイズ =================
  function resizeImageFile(file, maxEdge = 1024, quality = 0.78) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          let { width, height } = img;
          if (width > maxEdge || height > maxEdge) {
            const ratio = Math.min(maxEdge / width, maxEdge / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ================= Gemini API 通信（無料枠対応・429自動回避・Flash優先） =================
  function getApiKey() {
    return (localStorage.getItem(API_KEY_STORAGE) || '').trim();
  }

  function isDeprecatedOrProModel(id) {
    return (
      /^gemini-(1\.0|1\.5|2\.0|2\.5-flash$)/i.test(id) ||
      /pro/i.test(id) ||
      /embedding|aqa|imagen|veo|tts|audio|robotics|computer-use|deep-research|gemma|bisect/i.test(id)
    );
  }

  function scoreGeminiModel(modelId) {
    const verMatch = modelId.match(/^gemini-(\d+(?:\.\d+)?)/);
    const ver = verMatch ? parseFloat(verMatch[1]) : 0;
    const isLatestAlias = modelId === 'gemini-flash-latest' ? 1 : 0;
    const isFlash = /flash/i.test(modelId) ? 1 : 0;
    const isStable = /preview|exp/i.test(modelId) ? 0 : 1;
    return [isLatestAlias, isFlash, isStable, ver];
  }

  async function discoverAvailableFlashModels(apiKey) {
    try {
      const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(listUrl);
      if (!res.ok) return [];
      const data = await res.json();
      const models = Array.isArray(data.models) ? data.models : [];

      return models
        .filter(m =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent')
        )
        .map(m => String(m.name || '').replace(/^models\//, ''))
        .filter(id => id.startsWith('gemini-') && /flash/i.test(id) && !isDeprecatedOrProModel(id))
        .sort((a, b) => {
          const sa = scoreGeminiModel(a);
          const sb = scoreGeminiModel(b);
          for (let i = 0; i < sa.length; i++) {
            if (sb[i] !== sa[i]) return sb[i] - sa[i];
          }
          return b.localeCompare(a);
        })
        .slice(0, 4);
    } catch {
      return [];
    }
  }

  function extractJsonObject(rawText) {
    const stripped = String(rawText || '')
      .replace(/```json\s*/gi, '')
      .replace(/```/g, '')
      .trim();
    const firstBrace = stripped.indexOf('{');
    const lastBrace = stripped.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      throw new Error('AI応答の形式を解析できませんでした');
    }
    const jsonSlice = stripped
      .slice(firstBrace, lastBrace + 1)
      .replace(/:\s*(\d{1,3}),(\d{3})(?=\s*[,}\]])/g, ': $1$2');
    return JSON.parse(jsonSlice);
  }

  function parseNutritionResponse(rawText) {
    const text = String(rawText || '').trim();

    try {
      const obj = extractJsonObject(text);
      const cal = Number(String(obj.calories ?? '').replace(/,/g, ''));
      if (!Number.isNaN(cal) && cal > 0) {
        return {
          name: obj.name || '',
          calories: Math.round(cal),
          p: Number(String(obj.p ?? 0).replace(/,/g, '')) || 0,
          f: Number(String(obj.f ?? 0).replace(/,/g, '')) || 0,
          c: Number(String(obj.c ?? 0).replace(/,/g, '')) || 0,
          note: obj.note || '',
          breakdown: Array.isArray(obj.breakdown) ? obj.breakdown : []
        };
      }
    } catch {
      // 行ベース抽出へ進む
    }

    const grabNum = (patterns) => {
      for (const re of patterns) {
        const m = text.match(re);
        if (m && m[1]) {
          const val = parseFloat(m[1].replace(/,/g, ''));
          if (!Number.isNaN(val)) return val;
        }
      }
      return null;
    };

    const calories = grabNum([
      /CALORIES\s*[:：]\s*約?\s*([\d,]+(?:\.\d+)?)/i,
      /(?:総?カロリー|エネルギー)\s*[:：]?\s*約?\s*([\d,]+(?:\.\d+)?)\s*(?:kcal|キロカロリー)?/i,
      /約?\s*([\d,]{2,5})\s*kcal/i
    ]);

    if (calories === null || calories <= 0) {
      throw new Error('AIの回答からカロリー数値を読み取れませんでした');
    }

    const p = grabNum([
      /PROTEIN\s*[:：]\s*約?\s*([\d,]+(?:\.\d+)?)/i,
      /(?:タンパク質|たんぱく質|P)\s*[:：]\s*約?\s*([\d,]+(?:\.\d+)?)\s*g?/i
    ]) ?? 0;

    const f = grabNum([
      /FAT\s*[:：]\s*約?\s*([\d,]+(?:\.\d+)?)/i,
      /(?:脂質|F)\s*[:：]\s*約?\s*([\d,]+(?:\.\d+)?)\s*g?/i
    ]) ?? 0;

    const c = grabNum([
      /CARBS?\s*[:：]\s*約?\s*([\d,]+(?:\.\d+)?)/i,
      /(?:炭水化物|糖質|C)\s*[:：]\s*約?\s*([\d,]+(?:\.\d+)?)\s*g?/i
    ]) ?? 0;

    const nameMatch = text.match(/NAME\s*[:：]\s*(.+)/i) || text.match(/料理名\s*[:：]\s*(.+)/);
    const noteMatch = text.match(/NOTE\s*[:：]\s*(.+)/i) || text.match(/(?:メモ|目安|根拠)\s*[:：]\s*(.+)/);

    const breakdown = [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const bm = line.match(/^[-・*]\s*([^|｜:：]+?)\s*[|｜:：]\s*(?:約?\s*(\d+)\s*g\s*[|｜:：]\s*)?約?\s*([\d,]+)\s*kcal/i);
      if (bm) {
        breakdown.push({
          item: bm[1].trim(),
          grams: bm[2] ? parseInt(bm[2], 10) : 0,
          calories: parseInt(bm[3].replace(/,/g, ''), 10) || 0
        });
      }
    }

    return {
      name: nameMatch ? nameMatch[1].trim() : '',
      calories: Math.round(calories),
      p: Math.round(p * 10) / 10,
      f: Math.round(f * 10) / 10,
      c: Math.round(c * 10) / 10,
      note: noteMatch ? noteMatch[1].trim() : '',
      breakdown
    };
  }

  async function requestGenerateContent(apiKey, modelId, parts, useSearch = false, wantJson = false) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.25
      }
    };
    if (useSearch) {
      body.tools = [{ google_search: {} }];
    } else if (wantJson) {
      body.generationConfig.responseMimeType = 'application/json';
    }
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  function formatApiErrorMessage(status, errText) {
    if (status === 429) {
      return '無料枠の利用上限（429）に達しました。1分ほど待ってからもう一度「AI計算」を押してください。';
    }
    if (status === 401 || status === 403) {
      return 'APIキーの認証エラーです。「食材・設定」タブで正しいGemini APIキーを確認してください。';
    }
    return `APIエラー (${status}): ${errText.slice(0, 100)}`;
  }

  async function callGemini(promptText, base64DataUrl = null, options = {}) {
    const apiKey = getApiKey();
    if (!apiKey) return null;

    const useSearch = !!options.useSearch;
    const parserMode = options.parser || 'json';
    const parts = [{ text: promptText }];
    if (base64DataUrl) {
      const base64 = base64DataUrl.split(',')[1];
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: base64 } });
    }

    const cachedModel = (localStorage.getItem(MODEL_CACHE_STORAGE) || '').trim();
    const candidates = [];
    if (cachedModel && !isDeprecatedOrProModel(cachedModel)) {
      candidates.push(cachedModel);
    }
    FALLBACK_MODELS.forEach(m => {
      if (!candidates.includes(m)) candidates.push(m);
    });

    let firstMeaningfulError = null;
    let triedDiscovery = false;

    while (candidates.length > 0) {
      const modelId = candidates.shift();
      let res = await requestGenerateContent(apiKey, modelId, parts, useSearch, parserMode === 'json');
      let usedSearchActually = useSearch;

      // 無料枠でWeb検索(google_search)が429または400で弾かれた場合、同じモデルの標準AIモード(検索なし)で即再試行
      if (!res.ok && useSearch && (res.status === 429 || res.status === 400)) {
        res = await requestGenerateContent(apiKey, modelId, parts, false, parserMode === 'json');
        usedSearchActually = false;
      }

      if (res.ok) {
        const data = await res.json();
        const resParts = data?.candidates?.[0]?.content?.parts || [];
        const textParts = resParts
          .filter(p => !p.thought && typeof p.text === 'string')
          .map(p => p.text);
        const rawText = (textParts.length ? textParts.join('\n') : (resParts[0]?.text || '')).trim();

        const parsed = parserMode === 'nutrition'
          ? parseNutritionResponse(rawText)
          : extractJsonObject(rawText);

        const groundingChunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        parsed._grounded = usedSearchActually && groundingChunks.length > 0;
        parsed._model = modelId;
        if (cachedModel !== modelId) {
          localStorage.setItem(MODEL_CACHE_STORAGE, modelId);
        }
        return parsed;
      }

      const errText = await res.text();
      if (!firstMeaningfulError) {
        firstMeaningfulError = new Error(formatApiErrorMessage(res.status, errText));
      }

      if (res.status === 401 || res.status === 403) {
        throw firstMeaningfulError;
      }

      if (res.status === 404 || res.status === 429 || res.status === 400) {
        localStorage.removeItem(MODEL_CACHE_STORAGE);
        if (!triedDiscovery && candidates.length === 0) {
          triedDiscovery = true;
          const discovered = await discoverAvailableFlashModels(apiKey);
          discovered.forEach(m => {
            if (m !== modelId && !candidates.includes(m)) candidates.push(m);
          });
        }
        continue;
      }

      if (candidates.length === 0) {
        throw firstMeaningfulError;
      }
    }

    throw firstMeaningfulError || new Error('利用可能なGeminiモデルが見つかりませんでした');
  }

  // ================= AI 機能 =================

  // 1. 料理写真からカロリー・PFCを算出
  async function analyzeMealPhoto(file) {
    setLoading(true, '写真を解析し、食材・メニューからカロリー計算中...');
    try {
      const aiDataUrl = await resizeImageFile(file, 1024, 0.78);
      const thumbDataUrl = await resizeImageFile(file, 240, 0.55);

      const prompt = `添付された料理写真からメニュー名と大まかな栄養価を算出してください。
${NUTRITION_SYSTEM_RULE}

必ず以下の書式で出力してください（余計な挨拶は不要）:
NAME: 料理名
CALORIES: 数値(整数)
PROTEIN: 数値(小数1桁)
FAT: 数値(小数1桁)
CARBS: 数値(小数1桁)
NOTE: 写真から読み取った量や栄養バランスの一言コメント
BREAKDOWN:
- 食材名 | 120g | 230kcal
- 食材名 | 150g | 240kcal`;

      let result = await callGemini(prompt, aiDataUrl, { useSearch: true, parser: 'nutrition' });
      if (!result) {
        result = {
          name: '鶏の照り焼き定食（デモ解析）',
          calories: 642,
          p: 38.4,
          f: 18.2,
          c: 76.5,
          note: '※APIキー未設定のためデモ結果です。「食材・設定」タブにGemini APIキーを登録すると実写真の解析が行われます。',
          breakdown: [
            { item: '鶏もも肉（皮つき）', grams: 120, calories: 228 },
            { item: '精白米（めし）', grams: 160, calories: 250 },
            { item: '照り焼き調味料（醤油・みりん・砂糖）', grams: 25, calories: 52 },
            { item: '味噌汁（豆腐・わかめ）', grams: 150, calories: 58 },
            { item: 'サラダ油（調理用）', grams: 6, calories: 54 }
          ]
        };
      }

      const groundedTag = result._grounded ? '（Web検索参照）' : '';
      openMealModal({
        title: '📷 写真のカロリー算出結果',
        name: result.name || '',
        calories: Math.round(result.calories || 0),
        p: Number(result.p || 0),
        f: Number(result.f || 0),
        c: Number(result.c || 0),
        note: (result.note || '栄養成分データに基づき算出しました。') + groundedTag,
        breakdown: Array.isArray(result.breakdown) ? result.breakdown : [],
        photo: thumbDataUrl,
        timing: guessTimingByClock()
      });
    } catch (err) {
      showToast('写真解析に失敗しました: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  // 2. テキスト料理名からWeb検索＋AI推定で大まかなカロリー・PFCを算出
  async function estimateNutritionFromText(dishName) {
    if (!dishName.trim()) {
      showToast('先に料理名・食べたものを入力してください');
      return null;
    }
    setLoading(true, `「${dishName.trim()}」のカロリーをAI検索・計算中...`);
    try {
      const prompt = `以下の食事・メニューについて、公式栄養成分や一般的な1人前の栄養価をもとに、大まかで実用的なカロリー(kcal)とPFC(g)を算出してください。

対象メニュー・食事: 「${dishName.trim()}」
${NUTRITION_SYSTEM_RULE}

必ず以下の書式で出力してください（余計な挨拶は不要）:
CALORIES: 数値(整数)
PROTEIN: 数値(小数1桁)
FAT: 数値(小数1桁)
CARBS: 数値(小数1桁)
NOTE: 想定した1人前の量・サイズ感・目安レンジの簡潔な説明（例：標準サイズ・麺300g・全マシ想定でおよそ1,600〜1,800kcalの目安）
BREAKDOWN:
- 食材・構成パーツ名 | 300g | 1050kcal
- 食材・構成パーツ名 | 120g | 320kcal`;

      let res = await callGemini(prompt, null, { useSearch: true, parser: 'nutrition' });
      if (!res) {
        res = {
          calories: 560,
          p: 28.5,
          f: 16.0,
          c: 72.0,
          note: '※APIキー未設定のためデモ値です。「食材・設定」タブでAPIキーを保存するとAI計算に切り替わります。',
          breakdown: [
            { item: '主菜（肉・魚 推定120g）', grams: 120, calories: 230 },
            { item: '主食（ご飯・麺 推定150g）', grams: 150, calories: 240 },
            { item: '野菜・調理油・調味料', grams: 80, calories: 90 }
          ]
        };
        showToast('デモ計算を反映しました（APIキー設定でAI計算）');
      }
      return res;
    } catch (err) {
      showToast(err.message);
      return { _error: err.message };
    } finally {
      setLoading(false);
    }
  }

  // 3. レシート・購入食材写真から食品抽出
  async function analyzeReceiptPhoto(file) {
    setLoading(true, 'レシート/食材写真から食品を抽出中...');
    try {
      const aiDataUrl = await resizeImageFile(file, 1024, 0.78);
      const prompt = `添付されたレシートまたは購入した食材の写真から、料理に使える「食品・食材」だけを抽出してください。
レジ袋、消費税、割引、日用品、店舗名などは除外してください。
以下のJSON形式のみで返答してください:
{
  "items": [
    { "name": "食材名（例：鶏むね肉）", "amount": "分量目安（例：300g / 1パック）", "category": "肉・魚|野菜・きのこ|卵・乳・大豆|主食・麺|調味料・他" }
  ]
}`;
      let res = await callGemini(prompt, aiDataUrl, { useSearch: false, parser: 'json' });
      if (!res || !Array.isArray(res.items)) {
        res = {
          items: [
            { name: '鶏むね肉', amount: '350g', category: '肉・魚' },
            { name: '塩鮭切り身', amount: '2切れ', category: '肉・魚' },
            { name: '豚ロース薄切り', amount: '250g', category: '肉・魚' },
            { name: 'ブロッコリー', amount: '1株', category: '野菜・きのこ' },
            { name: 'キャベツ', amount: '1/2玉', category: '野菜・きのこ' },
            { name: 'しめじ', amount: '1パック', category: '野菜・きのこ' },
            { name: '絹ごし豆腐', amount: '1丁', category: '卵・乳・大豆' }
          ]
        };
        showToast('APIキー未設定のためデモ食材を抽出しました');
      }
      pendingReceiptItems = res.items;
      renderReceiptConfirmModal();
      openModal('modal-receipt');
    } catch (err) {
      showToast('食材抽出に失敗しました: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  // 4. 手持ち食材から指定曜日の夕食献立を作成
  async function generateDinnersWithAI(targetDays, preference = '') {
    if (targetDays.length === 0) {
      showToast('作成する曜日を1つ以上選んでください');
      return;
    }
    const { dinnerGuide } = calcMetrics();
    const activePantry = state.pantry.filter(i => !i.used).map(i => `${i.name}(${i.amount || '適量'})`);

    setLoading(true, `${targetDays.length}日分の夕食献立をAIで作成中...`);
    try {
      const dayLabels = targetDays.map(k => WEEKDAYS.find(w => w.key === k).full).join('、');
      const prompt = `あなたは管理栄養士です。以下の条件で1週間分の夕食献立を作成してください。
- 作成対象の曜日キー: ${JSON.stringify(targetDays)}（${dayLabels}）
- 優先して使う手持ち食材: ${activePantry.length ? activePantry.join('、') : '指定なし（スーパーで買いやすい定番食材）'}
- 1食あたりの目安カロリー: 約 ${dinnerGuide} kcal（±100kcal以内）
- ユーザーの希望条件: ${preference || '栄養バランス重視、家庭で作りやすいメニュー'}
${NUTRITION_SYSTEM_RULE}

以下のJSON形式のみで返答してください:
{
  "menus": {
    "mon": {
      "name": "主菜・副菜・主食を含む献立名",
      "ingredients": "主な使用食材とグラム数（例：鶏むね肉150g、ブロッコリー80g、ご飯150g）",
      "calories": 数値,
      "p": 数値,
      "f": 数値,
      "c": 数値,
      "breakdown": [
        { "item": "食材名", "grams": 数値, "calories": 数値 }
      ]
    }
  }
}
※menusのキーには指定された対象曜日キーのみを含めてください。`;

      let res = await callGemini(prompt, null, { useSearch: false, parser: 'json' });
      if (!res || !res.menus) {
        const scale = dinnerGuide / 700;
        const pool = [
          {
            name: '鶏むね肉のネギ塩焼き・ブロッコリーお浸し・ご飯',
            ingredients: `鶏むね肉 ${Math.round(140 * scale)}g、ブロッコリー 80g、長ねぎ 30g、ご飯 ${Math.round(150 * scale)}g`,
            calories: Math.round(670 * scale), p: +(42 * scale).toFixed(1), f: +(14 * scale).toFixed(1), c: +(88 * scale).toFixed(1),
            breakdown: [
              { item: '鶏むね肉（皮なし）', grams: Math.round(140 * scale), calories: Math.round(151 * scale) },
              { item: '精白米（めし）', grams: Math.round(150 * scale), calories: Math.round(234 * scale) },
              { item: 'ごま油・調味料・野菜', grams: 120, calories: Math.round(285 * scale) }
            ]
          },
          {
            name: '塩鮭のホイル焼き・しめじと豆腐の味噌汁・ご飯',
            ingredients: `銀鮭 ${Math.round(100 * scale)}g、しめじ 60g、豆腐 100g、ご飯 ${Math.round(150 * scale)}g`,
            calories: Math.round(690 * scale), p: +(36 * scale).toFixed(1), f: +(20 * scale).toFixed(1), c: +(86 * scale).toFixed(1),
            breakdown: [
              { item: '銀鮭切り身', grams: Math.round(100 * scale), calories: Math.round(190 * scale) },
              { item: '精白米（めし）', grams: Math.round(150 * scale), calories: Math.round(234 * scale) },
              { item: '豆腐・しめじ・味噌・バター', grams: 180, calories: Math.round(266 * scale) }
            ]
          },
          {
            name: '豚ロースの生姜焼き・キャベツ千切り・ご飯',
            ingredients: `豚ロース ${Math.round(110 * scale)}g、キャベツ 100g、玉ねぎ 50g、ご飯 ${Math.round(150 * scale)}g`,
            calories: Math.round(720 * scale), p: +(32 * scale).toFixed(1), f: +(24 * scale).toFixed(1), c: +(90 * scale).toFixed(1),
            breakdown: [
              { item: '豚ロース薄切り', grams: Math.round(110 * scale), calories: Math.round(272 * scale) },
              { item: '精白米（めし）', grams: Math.round(150 * scale), calories: Math.round(234 * scale) },
              { item: 'キャベツ・玉ねぎ・生姜焼きタレ・油', grams: 180, calories: Math.round(214 * scale) }
            ]
          },
          {
            name: 'サバの味噌煮・ほうれん草胡麻和え・ご飯',
            ingredients: `さば切り身 ${Math.round(100 * scale)}g、ほうれん草 80g、ご飯 ${Math.round(150 * scale)}g`,
            calories: Math.round(710 * scale), p: +(34 * scale).toFixed(1), f: +(25 * scale).toFixed(1), c: +(84 * scale).toFixed(1),
            breakdown: [
              { item: 'まさば切り身', grams: Math.round(100 * scale), calories: Math.round(211 * scale) },
              { item: '精白米（めし）', grams: Math.round(150 * scale), calories: Math.round(234 * scale) },
              { item: '味噌煮調味料・ほうれん草胡麻和え', grams: 120, calories: Math.round(265 * scale) }
            ]
          },
          {
            name: '鶏つくねとたっぷり野菜の鍋・雑穀ご飯',
            ingredients: `鶏ひき肉 ${Math.round(120 * scale)}g、白菜 120g、豆腐 100g、雑穀ご飯 ${Math.round(140 * scale)}g`,
            calories: Math.round(660 * scale), p: +(38 * scale).toFixed(1), f: +(16 * scale).toFixed(1), c: +(85 * scale).toFixed(1),
            breakdown: [
              { item: '鶏ひき肉（むね）', grams: Math.round(120 * scale), calories: Math.round(180 * scale) },
              { item: '雑穀ご飯', grams: Math.round(140 * scale), calories: Math.round(220 * scale) },
              { item: '豆腐・白菜・しめじ・鍋つゆ', grams: 300, calories: Math.round(260 * scale) }
            ]
          }
        ];
        res = { menus: {} };
        targetDays.forEach((dayKey, i) => {
          res.menus[dayKey] = pool[(i + Math.floor(Math.random() * pool.length)) % pool.length];
        });
        showToast('デモ献立を作成しました（APIキー設定で実AI生成）');
      }

      if (targetDays.length > 1) {
        WEEKDAYS.forEach(w => {
          state.weeklyMenu[w.key].excluded = !targetDays.includes(w.key);
        });
      }

      targetDays.forEach(dayKey => {
        const m = res.menus[dayKey];
        if (m) {
          state.weeklyMenu[dayKey] = {
            name: m.name || '',
            ingredients: m.ingredients || '',
            calories: Math.round(m.calories || 0),
            p: Number(m.p || 0),
            f: Number(m.f || 0),
            c: Number(m.c || 0),
            breakdown: Array.isArray(m.breakdown) ? m.breakdown : [],
            excluded: false
          };
        }
      });

      saveState();
      renderAll();
      closeModal('modal-ai-menu');
      showToast('夕食献立を反映しました');
    } catch (err) {
      showToast('献立作成に失敗しました: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  function guessTimingByClock() {
    const h = new Date().getHours();
    if (h < 10) return 'breakfast';
    if (h < 15) return 'lunch';
    if (h < 22) return 'dinner';
    return 'snack';
  }

  // ================= レンダリング =================
  function renderAll() {
    renderMealsTab();
    renderMenuTab();
    renderHistoryTab();
    renderSettingsTab();
  }

  // --- タブ1: 食事管理 ---
  function renderMealsTab() {
    const week = getCurrentWeekMap();
    const strip = $('#meal-weekday-strip');
    strip.innerHTML = week.map(w => {
      const hasLog = (state.dailyLogs[w.dateStr] || []).length > 0;
      const isActive = w.dateStr === selectedDateStr;
      return `
        <button type="button" class="day-pill ${isActive ? 'active' : ''} ${hasLog ? 'has-log' : ''}" data-date="${w.dateStr}">
          <span class="day-name">${w.label}</span>
          <span class="day-num">${w.dayNum}</span>
          <span class="day-dot"></span>
        </button>
      `;
    }).join('');

    const dayInfo = findDayInfoByDate(selectedDateStr);
    const logs = state.dailyLogs[selectedDateStr] || [];
    const totals = logs.reduce((acc, m) => ({
      cal: acc.cal + (Number(m.calories) || 0),
      p: acc.p + (Number(m.p) || 0),
      f: acc.f + (Number(m.f) || 0),
      c: acc.c + (Number(m.c) || 0)
    }), { cal: 0, p: 0, f: 0, c: 0 });

    const { target, targetP, targetF, targetC } = calcMetrics();
    const remaining = target - totals.cal;
    const pct = target > 0 ? Math.round((totals.cal / target) * 100) : 0;

    $('#selected-date-label').textContent = dayInfo
      ? `${dayInfo.monthDay}（${dayInfo.label}）の摂取カロリー`
      : `${selectedDateStr} の摂取カロリー`;
    $('#eaten-cal').textContent = totals.cal.toLocaleString();
    $('#target-cal-display').textContent = target.toLocaleString();

    const remEl = $('#remaining-cal-badge');
    remEl.textContent = remaining >= 0 ? `残り ${remaining.toLocaleString()} kcal` : `${Math.abs(remaining).toLocaleString()} kcal オーバー`;
    remEl.className = `remaining-badge ${remaining >= 0 ? 'ok' : 'over'}`;

    const circ = 251.33;
    const offset = circ - (circ * Math.min(100, pct)) / 100;
    const ring = $('#ring-progress');
    ring.style.strokeDashoffset = offset;
    ring.classList.toggle('over', remaining < 0);
    $('#ring-percent').textContent = `${pct}%`;

    $('#p-val').textContent = `${totals.p.toFixed(1)} / ${targetP}g`;
    $('#f-val').textContent = `${totals.f.toFixed(1)} / ${targetF}g`;
    $('#c-val').textContent = `${totals.c.toFixed(1)} / ${targetC}g`;
    $('#p-bar').style.width = `${Math.min(100, (totals.p / Math.max(1, targetP)) * 100)}%`;
    $('#f-bar').style.width = `${Math.min(100, (totals.f / Math.max(1, targetF)) * 100)}%`;
    $('#c-bar').style.width = `${Math.min(100, (totals.c / Math.max(1, targetC)) * 100)}%`;

    const linkedBox = $('#linked-dinner-box');
    const menuItem = dayInfo ? state.weeklyMenu[dayInfo.key] : null;
    if (dayInfo && menuItem && menuItem.name && !menuItem.excluded) {
      const isChecked = logs.some(m => m.fromMenuDay === dayInfo.key);
      linkedBox.classList.remove('hidden');
      linkedBox.innerHTML = `
        <span class="linked-badge">📅 ${dayInfo.full}の夕食献立と連動</span>
        <div class="linked-row">
          <button type="button" class="check-btn ${isChecked ? 'checked' : ''}" id="btn-toggle-linked-dinner">✓</button>
          <div class="meal-info">
            <div class="meal-name">${escapeHtml(menuItem.name)}</div>
            <div class="meal-meta">${menuItem.calories} kcal（P:${menuItem.p}g / F:${menuItem.f}g / C:${menuItem.c}g）</div>
          </div>
        </div>
      `;
    } else {
      linkedBox.classList.add('hidden');
      linkedBox.innerHTML = '';
    }

    const secContainer = $('#daily-meal-sections');
    secContainer.innerHTML = TIMINGS.map(t => {
      const items = logs.filter(m => m.timing === t.key);
      const secCal = items.reduce((s, m) => s + (Number(m.calories) || 0), 0);
      const rows = items.length === 0
        ? `<p class="muted-text small">記録なし</p>`
        : items.map(item => {
            const bdText = (item.breakdown && item.breakdown.length)
              ? `<div class="meal-breakdown-mini">内訳目安: ${item.breakdown.map(b => `${escapeHtml(b.item)}${b.grams ? ` ${b.grams}g` : ''}(${b.calories}kcal)`).join(' / ')}</div>`
              : '';
            return `
              <div class="meal-row">
                ${item.photo ? `<img class="meal-thumb" src="${item.photo}" alt="食事写真" />` : ''}
                <div class="meal-info">
                  <div class="meal-name">${escapeHtml(item.name)}</div>
                  <div class="meal-meta">${item.calories} kcal ・ P:${item.p}g F:${item.f}g C:${item.c}g</div>
                  ${bdText}
                </div>
                <button type="button" class="btn-del-mini" data-del-meal="${item.id}" aria-label="削除">✕</button>
              </div>
            `;
          }).join('');
      return `
        <div class="meal-section-card">
          <div class="meal-sec-head">
            <span class="meal-sec-title">${t.label}</span>
            <span class="meal-sec-cal">${secCal} kcal</span>
          </div>
          ${rows}
        </div>
      `;
    }).join('');
  }

  // --- タブ2: 夕食献立 ---
  function renderMenuTab() {
    const activePantryCount = state.pantry.filter(i => !i.used).length;
    $('#pantry-count-pill').textContent = `食材 ${activePantryCount}品`;

    const week = getCurrentWeekMap();
    const list = $('#weekly-menu-list');
    list.innerHTML = week.map(w => {
      const m = state.weeklyMenu[w.key];
      const dayLogs = state.dailyLogs[w.dateStr] || [];
      const isEaten = dayLogs.some(x => x.fromMenuDay === w.key);

      let bodyHtml = '';
      if (m.excluded) {
        bodyHtml = `<p class="muted-text small">この日は夕食作成から除外されています（外食・不要）</p>`;
      } else if (!m.name) {
        bodyHtml = `<p class="muted-text small">未設定（「手持ち食材から作成」または「編集」で設定）</p>`;
      } else {
        const bdMini = (m.breakdown && m.breakdown.length)
          ? `<div class="meal-breakdown-mini">内訳目安: ${m.breakdown.map(b => `${escapeHtml(b.item)}${b.grams ? ` ${b.grams}g` : ''}(${b.calories}kcal)`).join(' / ')}</div>`
          : '';
        bodyHtml = `
          <div class="menu-dish-title">${escapeHtml(m.name)}</div>
          <div class="meal-meta">${m.calories} kcal（P:${m.p}g / F:${m.f}g / C:${m.c}g）</div>
          ${m.ingredients ? `<div class="muted-text small mt-8">食材: ${escapeHtml(m.ingredients)}</div>` : ''}
          ${bdMini}
        `;
      }

      return `
        <div class="menu-day-card ${m.excluded ? 'excluded' : ''}">
          <div class="menu-day-head">
            <div class="day-tag">
              <span>${w.monthDay}（${w.label}）</span>
              ${isEaten ? '<span class="status-pill eaten">✓ 摂取済</span>' : ''}
              ${m.excluded ? '<span class="status-pill excluded">除外</span>' : ''}
            </div>
            ${(!m.excluded && m.name) ? `<button type="button" class="check-btn ${isEaten ? 'checked' : ''}" data-menu-eaten="${w.key}" title="食べたチェック">✓</button>` : ''}
          </div>
          ${bodyHtml}
          <div class="menu-actions">
            <button type="button" class="btn-xs ai" data-menu-regen="${w.key}">✨ AI提案</button>
            <button type="button" class="btn-xs" data-menu-edit="${w.key}">✏️ 編集</button>
            <button type="button" class="btn-xs" data-menu-exclude="${w.key}">${m.excluded ? '除外を解除' : 'この日を除く'}</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // --- タブ3: 推移・履歴 ---
  function renderHistoryTab() {
    const { target } = calcMetrics();
    const days = [];
    const today = new Date();
    for (let i = historyRange - 1; i >= 0; i--) {
      const dt = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const ds = formatDate(dt);
      const logs = state.dailyLogs[ds] || [];
      const cal = logs.reduce((s, x) => s + (Number(x.calories) || 0), 0);
      const p = logs.reduce((s, x) => s + (Number(x.p) || 0), 0);
      const f = logs.reduce((s, x) => s + (Number(x.f) || 0), 0);
      const c = logs.reduce((s, x) => s + (Number(x.c) || 0), 0);
      days.push({
        dateStr: ds,
        label: `${dt.getMonth() + 1}/${dt.getDate()}`,
        cal, p, f, c, logs
      });
    }

    const logged = days.filter(d => d.cal > 0);
    const avgCal = logged.length ? Math.round(logged.reduce((s, d) => s + d.cal, 0) / logged.length) : 0;
    const hitCount = logged.filter(d => d.cal <= target * 1.08 && d.cal >= target * 0.75).length;
    const hitRate = logged.length ? Math.round((hitCount / logged.length) * 100) : 0;
    const avgP = logged.length ? (logged.reduce((s, d) => s + d.p, 0) / logged.length).toFixed(1) : 0;
    const avgF = logged.length ? (logged.reduce((s, d) => s + d.f, 0) / logged.length).toFixed(1) : 0;
    const avgC = logged.length ? (logged.reduce((s, d) => s + d.c, 0) / logged.length).toFixed(1) : 0;

    $('#stat-avg-cal').textContent = `${avgCal.toLocaleString()} kcal`;
    $('#stat-logged-days').textContent = `${logged.length} 日`;
    $('#stat-hit-rate').textContent = `${hitRate}%`;
    $('#chart-target-legend').textContent = `破線: 目標 ${target} kcal`;
    $('#stat-avg-pfc').textContent = `平均PFC: P ${avgP}g / F ${avgF}g / C ${avgC}g`;

    const maxVal = Math.max(target * 1.25, ...days.map(d => d.cal), 1000);
    const barW = historyRange === 7 ? 38 : 22;
    const gap = historyRange === 7 ? 10 : 6;
    const svgW = Math.max(320, days.length * (barW + gap) + 20);
    const chartH = 140;
    const targetY = chartH - (target / maxVal) * (chartH - 20);

    const barsSvg = days.map((d, idx) => {
      const x = 10 + idx * (barW + gap);
      const h = d.cal > 0 ? Math.max(4, (d.cal / maxVal) * (chartH - 20)) : 0;
      const y = chartH - h;
      const color = d.cal > target * 1.05 ? '#ef4444' : '#059669';
      return `
        <g>
          <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="5" fill="${color}" opacity="${d.cal ? 0.9 : 0.15}" />
          ${d.cal > 0 && historyRange === 7 ? `<text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" font-size="9" fill="#374151">${d.cal}</text>` : ''}
          ${(historyRange === 7 || idx % 5 === 0) ? `<text x="${x + barW / 2}" y="${chartH + 14}" text-anchor="middle" font-size="9" fill="#6b7280">${d.label}</text>` : ''}
        </g>
      `;
    }).join('');

    $('#calorie-chart-container').innerHTML = `
      <svg width="${svgW}" height="${chartH + 22}" viewBox="0 0 ${svgW} ${chartH + 22}">
        <line x1="0" y1="${targetY}" x2="${svgW}" y2="${targetY}" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4 3" />
        ${barsSvg}
      </svg>
    `;

    renderWeightChart();

    const logList = $('#history-log-list');
    const revLogged = [...logged].reverse();
    if (revLogged.length === 0) {
      logList.innerHTML = `<p class="muted-text small">この期間の食事記録はまだありません。「食事管理」タブから記録すると自動で蓄積されます。</p>`;
    } else {
      logList.innerHTML = revLogged.map(d => `
        <div class="history-acc-item">
          <button type="button" class="history-acc-head" data-acc-toggle="acc-${d.dateStr}">
            <span>${d.dateStr}</span>
            <span>${d.cal.toLocaleString()} kcal（${d.logs.length}件）▾</span>
          </button>
          <div id="acc-${d.dateStr}" class="history-acc-body hidden">
            ${d.logs.map(m => `
              <div class="meal-row">
                ${m.photo ? `<img class="meal-thumb" src="${m.photo}" alt="記録写真" />` : ''}
                <div class="meal-info">
                  <div class="meal-name">${escapeHtml(m.name)}</div>
                  <div class="meal-meta">${m.calories} kcal ・ P:${m.p}g F:${m.f}g C:${m.c}g</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('');
    }
  }

  function renderWeightChart() {
    const container = $('#weight-chart-container');
    const hist = [...state.weightHistory].sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
    if (hist.length < 2) {
      container.innerHTML = hist.length === 1
        ? `<p class="muted-text small">現在の記録: ${hist[0].date}（${hist[0].weight} kg）。2件以上記録するとグラフが表示されます。</p>`
        : `<p class="muted-text small">まだ体重の記録がありません。「+ 今日の体重を記録」から追加できます。</p>`;
      return;
    }

    const weights = hist.map(h => h.weight);
    const minW = Math.min(...weights) - 1;
    const maxW = Math.max(...weights) + 1;
    const w = 320, h = 110, pad = 22;
    const pts = hist.map((item, i) => {
      const x = pad + (i / (hist.length - 1)) * (w - pad * 2);
      const y = h - pad - ((item.weight - minW) / Math.max(0.5, maxW - minW)) * (h - pad * 2);
      return { x, y, ...item };
    });

    const poly = pts.map(p => `${p.x},${p.y}`).join(' ');
    container.innerHTML = `
      <svg width="100%" viewBox="0 0 ${w} ${h + 12}">
        <polyline fill="none" stroke="#059669" stroke-width="2.5" points="${poly}" />
        ${pts.map(p => `
          <circle cx="${p.x}" cy="${p.y}" r="3.5" fill="#059669" />
          <text x="${p.x}" y="${p.y - 7}" text-anchor="middle" font-size="9" fill="#374151">${p.weight}</text>
          <text x="${p.x}" y="${h + 4}" text-anchor="middle" font-size="8" fill="#6b7280">${p.date.slice(5)}</text>
        `).join('')}
      </svg>
    `;
  }

  // --- タブ4: 食材・設定 ---
  function renderSettingsTab() {
    const pList = $('#pantry-list');
    if (state.pantry.length === 0) {
      pList.innerHTML = `<p class="muted-text small">手持ち食材が登録されていません。レシート撮影または手動追加で登録してください。</p>`;
    } else {
      pList.innerHTML = state.pantry.map(item => `
        <div class="pantry-row ${item.used ? 'used' : ''}">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;">
            <button type="button" class="check-btn ${item.used ? 'checked' : ''}" data-pantry-toggle="${item.id}">✓</button>
            <span class="pantry-cat">${escapeHtml(item.category || '食品')}</span>
            <span style="font-weight:600;font-size:14px;">${escapeHtml(item.name)}</span>
            <span class="muted-text small">${escapeHtml(item.amount || '')}</span>
          </div>
          <button type="button" class="btn-del-mini" data-pantry-del="${item.id}">✕</button>
        </div>
      `).join('');
    }

    const p = state.profile;
    const { bmr, tdee, target, dinnerGuide } = calcMetrics();
    $('#settings-target-cal').textContent = target.toLocaleString();
    $('#settings-bmr-tdee').textContent = `基礎代謝: ${bmr} kcal / 総消費: ${tdee} kcal`;

    $('#prof-weight').value = p.weight;
    $('#prof-height').value = p.height;
    $('#prof-age').value = p.age;
    $('#prof-gender').value = p.gender;
    $('#prof-activity').value = String(p.activity);
    $('#prof-goal').value = String(p.goalOffset);
    $('#prof-manual-toggle').checked = !!p.useManualTarget;
    $('#prof-manual-cal').value = p.manualTarget || target;
    $('#manual-cal-wrap').classList.toggle('hidden', !p.useManualTarget);

    $('#prof-dinner-ratio').value = p.dinnerRatio || 40;
    $('#dinner-ratio-label').textContent = `${p.dinnerRatio || 40}%`;
    $('#dinner-cal-guide').textContent = dinnerGuide;

    const savedKey = getApiKey();
    const activeModel = (localStorage.getItem(MODEL_CACHE_STORAGE) || '').trim();
    $('#input-api-key').value = savedKey;
    $('#api-key-status').textContent = savedKey
      ? `✅ APIキー設定済み（AI計算有効 / モデル: ${activeModel || 'Flash最新モデル自動選択'}）`
      : 'ℹ️ 未設定（現在はデモAIモードで動作中）';
  }

  // ================= モーダル表示ヘルパー =================
  function openMealModal(opts = {}) {
    currentMealDraftPhoto = opts.photo || '';
    currentMealDraftBreakdown = opts.breakdown || [];
    currentMealDraftNote = opts.note || '';

    $('#modal-meal-title').textContent = opts.title || '食事を記録';
    $('#meal-input-timing').value = opts.timing || guessTimingByClock();
    $('#meal-input-name').value = opts.name || '';
    $('#meal-input-cal').value = opts.calories || '';
    $('#meal-input-p').value = opts.p || '';
    $('#meal-input-f').value = opts.f || '';
    $('#meal-input-c').value = opts.c || '';

    const prevWrap = $('#meal-photo-preview-wrap');
    if (currentMealDraftPhoto) {
      prevWrap.classList.remove('hidden');
      $('#meal-photo-preview').src = currentMealDraftPhoto;
      $('#meal-ai-note').textContent = '';
    } else {
      prevWrap.classList.add('hidden');
    }

    renderMealModalBreakdown();
    openModal('modal-meal');
  }

  function renderMealModalBreakdown(errorMsg = '') {
    const wrap = $('#meal-breakdown-wrap');
    const ul = $('#meal-breakdown-list');
    if (!wrap || !ul) return;

    let noteBox = document.getElementById('meal-ai-inline-note');
    if (!noteBox) {
      noteBox = document.createElement('div');
      noteBox.id = 'meal-ai-inline-note';
      noteBox.style.cssText = 'font-size:12px;line-height:1.5;padding:8px 10px;border-radius:8px;margin-bottom:8px;';
      ul.parentNode.insertBefore(noteBox, ul);
    }

    if (errorMsg) {
      wrap.classList.remove('hidden');
      noteBox.style.display = 'block';
      noteBox.style.background = '#fef2f2';
      noteBox.style.color = '#b91c1c';
      noteBox.style.border = '1px solid #fecaca';
      noteBox.textContent = `⚠️ ${errorMsg}`;
      ul.innerHTML = '';
      return;
    }

    if (!currentMealDraftNote && !currentMealDraftBreakdown.length) {
      wrap.classList.add('hidden');
      noteBox.style.display = 'none';
      return;
    }

    wrap.classList.remove('hidden');
    if (currentMealDraftNote) {
      noteBox.style.display = 'block';
      noteBox.style.background = '#ecfdf5';
      noteBox.style.color = '#065f46';
      noteBox.style.border = '1px solid #a7f3d0';
      noteBox.textContent = `✨ ${currentMealDraftNote}`;
    } else {
      noteBox.style.display = 'none';
    }

    ul.innerHTML = currentMealDraftBreakdown.map(b => `
      <li>
        <span>${escapeHtml(b.item)}${b.grams ? `（約${b.grams}g）` : ''}</span>
        <strong>${b.calories} kcal</strong>
      </li>
    `).join('');
  }

  function openAiMenuModal() {
    const { dinnerGuide } = calcMetrics();
    const activeCount = state.pantry.filter(i => !i.used).length;
    $('#ai-menu-pantry-summary').textContent = `${activeCount}品`;
    $('#ai-menu-cal-guide').textContent = `${dinnerGuide} kcal`;

    aiMenuDaySelection = {};
    WEEKDAYS.forEach(w => {
      aiMenuDaySelection[w.key] = !state.weeklyMenu[w.key].excluded;
    });
    renderAiMenuDayToggles();
    openModal('modal-ai-menu');
  }

  function renderAiMenuDayToggles() {
    $('#ai-menu-day-toggles').innerHTML = WEEKDAYS.map(w => {
      const on = aiMenuDaySelection[w.key];
      return `
        <button type="button" class="day-toggle-btn ${on ? '' : 'off'}" data-ai-day="${w.key}">
          <span>${w.label}</span>
          <span>${on ? '作成' : '除く'}</span>
        </button>
      `;
    }).join('');
  }

  function openEditDinnerModal(dayKey) {
    editingDinnerDayKey = dayKey;
    const wd = WEEKDAYS.find(w => w.key === dayKey);
    const m = state.weeklyMenu[dayKey];
    $('#modal-edit-dinner-title').textContent = `${wd.full}の夕食献立`;
    $('#edit-dinner-name').value = m.name || '';
    $('#edit-dinner-ingredients').value = m.ingredients || '';
    $('#edit-dinner-cal').value = m.calories || '';
    $('#edit-dinner-p').value = m.p || '';
    $('#edit-dinner-f').value = m.f || '';
    $('#edit-dinner-c').value = m.c || '';
    openModal('modal-edit-dinner');
  }

  function openRecipeModal() {
    $('#recipe-target-day').innerHTML = WEEKDAYS.map(w => `<option value="${w.key}">${w.full}</option>`).join('');
    const activePantry = state.pantry.filter(i => !i.used).slice(0, 10);
    $('#recipe-pantry-chips').innerHTML = activePantry.map(i =>
      `<button type="button" class="chip-btn" data-chip-word="${escapeHtml(i.name)}">+ ${escapeHtml(i.name)}</button>`
    ).join('');
    openModal('modal-recipe');
  }

  function renderReceiptConfirmModal() {
    const list = $('#receipt-extracted-list');
    list.innerHTML = pendingReceiptItems.map((item, idx) => `
      <div class="extracted-row">
        <input type="checkbox" checked data-ext-check="${idx}" class="switch-input" />
        <input type="text" value="${escapeHtml(item.name)}" data-ext-name="${idx}" />
        <input type="text" value="${escapeHtml(item.amount || '')}" placeholder="分量" data-ext-amount="${idx}" />
      </div>
    `).join('');
  }

  // ================= 連動トグル処理 =================
  function toggleLinkedDinner(dayKey) {
    const week = getCurrentWeekMap();
    const dayInfo = week.find(w => w.key === dayKey);
    if (!dayInfo) return;
    const menu = state.weeklyMenu[dayKey];
    if (!menu || !menu.name) return;

    if (!state.dailyLogs[dayInfo.dateStr]) state.dailyLogs[dayInfo.dateStr] = [];
    const logs = state.dailyLogs[dayInfo.dateStr];
    const existingIdx = logs.findIndex(x => x.fromMenuDay === dayKey);

    if (existingIdx >= 0) {
      logs.splice(existingIdx, 1);
      showToast('夕食の摂取チェックを解除しました');
    } else {
      logs.push({
        id: 'menu_' + Date.now(),
        timing: 'dinner',
        name: menu.name,
        calories: menu.calories,
        p: menu.p,
        f: menu.f,
        c: menu.c,
        breakdown: menu.breakdown || [],
        photo: '',
        fromMenuDay: dayKey
      });
      showToast(`${dayInfo.full}の夕食を摂取済にしました`);
    }
    saveState();
    renderAll();
  }

  // ================= イベント登録 =================
  function bindEvents() {
    const tabTitles = {
      meals: ['食事管理', 'AI検索＆成分表ベース計算'],
      menu: ['夕食献立（月〜日）', '手持ち食材から必要な曜日だけ作成'],
      history: ['推移・履歴', '日別カロリー・PFC・体重ログ'],
      settings: ['食材・設定', 'レシート読込・身体データ・API設定']
    };

    $$('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        $$('.nav-item').forEach(b => b.classList.toggle('active', b === btn));
        $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
        $('#header-title').textContent = tabTitles[tab][0];
        $('#header-subtitle').textContent = tabTitles[tab][1];
        renderAll();
      });
    });

    $$('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => closeModal(btn.dataset.close));
    });
    $$('.modal-backdrop').forEach(bg => {
      bg.addEventListener('click', e => { if (e.target === bg) closeModal(bg.id); });
    });

    $('#meal-weekday-strip').addEventListener('click', e => {
      const btn = e.target.closest('[data-date]');
      if (!btn) return;
      selectedDateStr = btn.dataset.date;
      renderMealsTab();
    });

    $('#linked-dinner-box').addEventListener('click', e => {
      if (e.target.closest('#btn-toggle-linked-dinner')) {
        const dayInfo = findDayInfoByDate(selectedDateStr);
        if (dayInfo) toggleLinkedDinner(dayInfo.key);
      }
    });

    $('#daily-meal-sections').addEventListener('click', e => {
      const delBtn = e.target.closest('[data-del-meal]');
      if (!delBtn) return;
      const id = delBtn.dataset.delMeal;
      state.dailyLogs[selectedDateStr] = (state.dailyLogs[selectedDateStr] || []).filter(m => m.id !== id);
      saveState();
      renderAll();
      showToast('食事記録を削除しました');
    });

    $('#btn-meal-camera').addEventListener('click', () => $('#input-meal-camera').click());
    $('#btn-meal-album').addEventListener('click', () => $('#input-meal-album').click());
    $('#input-meal-camera').addEventListener('change', e => {
      if (e.target.files[0]) analyzeMealPhoto(e.target.files[0]);
      e.target.value = '';
    });
    $('#input-meal-album').addEventListener('change', e => {
      if (e.target.files[0]) analyzeMealPhoto(e.target.files[0]);
      e.target.value = '';
    });
    $('#btn-meal-manual').addEventListener('click', () => openMealModal({ title: '食事を手入力 / AI検索計算' }));

    $('#btn-estimate-text-cal').addEventListener('click', async () => {
      const res = await estimateNutritionFromText($('#meal-input-name').value);
      if (!res) return;
      if (res._error) {
        renderMealModalBreakdown(res._error);
        return;
      }
      const cal = Math.round(res.calories || 0);
      const pVal = Number(res.p || 0);
      const fVal = Number(res.f || 0);
      const cVal = Number(res.c || 0);
      $('#meal-input-cal').value = cal;
      $('#meal-input-p').value = pVal;
      $('#meal-input-f').value = fVal;
      $('#meal-input-c').value = cVal;
      const groundedTag = res._grounded ? '（Web検索参照）' : '';
      currentMealDraftNote = (res.note || `目安カロリー: ${cal.toLocaleString()} kcal`) + groundedTag;
      currentMealDraftBreakdown = Array.isArray(res.breakdown) ? res.breakdown : [];
      renderMealModalBreakdown();
      renderSettingsTab();
      showToast(`約 ${cal.toLocaleString()} kcal で算出しました`);
    });

    $('#btn-eiyou-meal-search').addEventListener('click', () => {
      openEiyouKeisan($('#meal-input-name').value);
    });

    $('#btn-save-meal-entry').addEventListener('click', () => {
      const name = $('#meal-input-name').value.trim();
      if (!name) { showToast('料理名を入力してください'); return; }
      if (!state.dailyLogs[selectedDateStr]) state.dailyLogs[selectedDateStr] = [];
      state.dailyLogs[selectedDateStr].push({
        id: 'meal_' + Date.now(),
        timing: $('#meal-input-timing').value,
        name,
        calories: Math.round(Number($('#meal-input-cal').value) || 0),
        p: Number($('#meal-input-p').value) || 0,
        f: Number($('#meal-input-f').value) || 0,
        c: Number($('#meal-input-c').value) || 0,
        breakdown: currentMealDraftBreakdown,
        photo: currentMealDraftPhoto
      });
      saveState();
      closeModal('modal-meal');
      renderAll();
      showToast('食事を記録しました');
    });

    // タブ2: 夕食献立
    $('#btn-open-ai-menu').addEventListener('click', openAiMenuModal);
    $('#btn-open-recipe-search').addEventListener('click', openRecipeModal);

    $('#ai-menu-day-toggles').addEventListener('click', e => {
      const btn = e.target.closest('[data-ai-day]');
      if (!btn) return;
      const k = btn.dataset.aiDay;
      aiMenuDaySelection[k] = !aiMenuDaySelection[k];
      renderAiMenuDayToggles();
    });

    $('#btn-run-ai-menu').addEventListener('click', () => {
      const targets = WEEKDAYS.map(w => w.key).filter(k => aiMenuDaySelection[k]);
      generateDinnersWithAI(targets, $('#ai-menu-pref').value.trim());
    });

    $('#weekly-menu-list').addEventListener('click', e => {
      const regen = e.target.closest('[data-menu-regen]');
      if (regen) { generateDinnersWithAI([regen.dataset.menuRegen], ''); return; }

      const edit = e.target.closest('[data-menu-edit]');
      if (edit) { openEditDinnerModal(edit.dataset.menuEdit); return; }

      const exc = e.target.closest('[data-menu-exclude]');
      if (exc) {
        const k = exc.dataset.menuExclude;
        state.weeklyMenu[k].excluded = !state.weeklyMenu[k].excluded;
        saveState();
        renderAll();
        return;
      }

      const eaten = e.target.closest('[data-menu-eaten]');
      if (eaten) { toggleLinkedDinner(eaten.dataset.menuEaten); }
    });

    $('#btn-estimate-dinner-cal').addEventListener('click', async () => {
      const res = await estimateNutritionFromText($('#edit-dinner-name').value);
      if (!res || res._error) return;
      $('#edit-dinner-cal').value = Math.round(res.calories || 0);
      $('#edit-dinner-p').value = Number(res.p || 0);
      $('#edit-dinner-f').value = Number(res.f || 0);
      $('#edit-dinner-c').value = Number(res.c || 0);
    });

    $('#btn-eiyou-dinner-search').addEventListener('click', () => {
      openEiyouKeisan($('#edit-dinner-name').value);
    });

    $('#btn-save-edit-dinner').addEventListener('click', () => {
      state.weeklyMenu[editingDinnerDayKey] = {
        ...state.weeklyMenu[editingDinnerDayKey],
        name: $('#edit-dinner-name').value.trim(),
        ingredients: $('#edit-dinner-ingredients').value.trim(),
        calories: Math.round(Number($('#edit-dinner-cal').value) || 0),
        p: Number($('#edit-dinner-p').value) || 0,
        f: Number($('#edit-dinner-f').value) || 0,
        c: Number($('#edit-dinner-c').value) || 0,
        excluded: false
      };
      saveState();
      closeModal('modal-edit-dinner');
      renderAll();
      showToast('夕食献立を保存しました');
    });

    $('#recipe-pantry-chips').addEventListener('click', e => {
      const chip = e.target.closest('[data-chip-word]');
      if (!chip) return;
      const input = $('#recipe-search-keyword');
      input.value = (input.value + ' ' + chip.dataset.chipWord).trim();
    });

    $$('[data-site]').forEach(btn => {
      btn.addEventListener('click', () => {
        const kw = $('#recipe-search-keyword').value.trim();
        const enc = encodeURIComponent(kw);
        const site = btn.dataset.site;
        if (site === 'eiyou') { openEiyouKeisan(kw); return; }
        const urls = {
          cookpad: kw ? `https://cookpad.com/jp/search/${enc}` : 'https://cookpad.com/',
          kurashiru: kw ? `https://www.kurashiru.com/search?query=${enc}` : 'https://www.kurashiru.com/',
          delish: kw ? `https://delishkitchen.tv/search?q=${enc}` : 'https://delishkitchen.tv/'
        };
        window.open(urls[site], '_blank', 'noopener,noreferrer');
      });
    });

    $('#btn-estimate-recipe-cal').addEventListener('click', async () => {
      const res = await estimateNutritionFromText($('#recipe-import-name').value);
      if (!res || res._error) return;
      $('#recipe-import-cal').value = Math.round(res.calories || 0);
      $('#recipe-import-p').value = Number(res.p || 0);
      $('#recipe-import-f').value = Number(res.f || 0);
      $('#recipe-import-c').value = Number(res.c || 0);
    });

    $('#btn-import-recipe').addEventListener('click', () => {
      const name = $('#recipe-import-name').value.trim();
      if (!name) { showToast('料理名を入力してください'); return; }
      const dayKey = $('#recipe-target-day').value;
      state.weeklyMenu[dayKey] = {
        name,
        ingredients: $('#recipe-search-keyword').value.trim(),
        calories: Math.round(Number($('#recipe-import-cal').value) || 0),
        p: Number($('#recipe-import-p').value) || 0,
        f: Number($('#recipe-import-f').value) || 0,
        c: Number($('#recipe-import-c').value) || 0,
        breakdown: [],
        excluded: false
      };
      saveState();
      closeModal('modal-recipe');
      renderAll();
      showToast('レシピを夕食献立に登録しました');
    });

    // タブ3: 推移・履歴
    $('#history-range-toggle').addEventListener('click', e => {
      const btn = e.target.closest('[data-range]');
      if (!btn) return;
      historyRange = Number(btn.dataset.range);
      $$('#history-range-toggle .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderHistoryTab();
    });

    $('#history-log-list').addEventListener('click', e => {
      const btn = e.target.closest('[data-acc-toggle]');
      if (!btn) return;
      const target = document.getElementById(btn.dataset.accToggle);
      if (target) target.classList.toggle('hidden');
    });

    $('#btn-quick-weight').addEventListener('click', () => {
      const input = prompt('今日の体重 (kg) を入力してください', String(state.profile.weight));
      const val = parseFloat(input);
      if (!val || val <= 0) return;
      recordWeight(val);
    });

    $('#btn-load-sample-history').addEventListener('click', () => {
      const today = new Date();
      const { target } = calcMetrics();
      for (let i = 1; i <= 6; i++) {
        const dt = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
        const ds = formatDate(dt);
        if (!state.dailyLogs[ds] || state.dailyLogs[ds].length === 0) {
          const offset = (i % 3 - 1) * 140;
          const total = Math.max(1300, target + offset);
          state.dailyLogs[ds] = [
            { id: `s_${i}_1`, timing: 'breakfast', name: '納豆ご飯・味噌汁', calories: Math.round(total * 0.25), p: 18, f: 9, c: 62 },
            { id: `s_${i}_2`, timing: 'lunch', name: '鶏むね肉定食', calories: Math.round(total * 0.35), p: 36, f: 16, c: 82 },
            { id: `s_${i}_3`, timing: 'dinner', name: '焼き魚・副菜・ご飯', calories: Math.round(total * 0.4), p: 32, f: 18, c: 85 }
          ];
        }
      }
      saveState();
      renderAll();
      showToast('過去6日分のデモ履歴を追加しました');
    });

    // タブ4: 食材・設定
    $('#btn-receipt-camera').addEventListener('click', () => $('#input-receipt-camera').click());
    $('#btn-receipt-album').addEventListener('click', () => $('#input-receipt-album').click());
    $('#input-receipt-camera').addEventListener('change', e => {
      if (e.target.files[0]) analyzeReceiptPhoto(e.target.files[0]);
      e.target.value = '';
    });
    $('#input-receipt-album').addEventListener('change', e => {
      if (e.target.files[0]) analyzeReceiptPhoto(e.target.files[0]);
      e.target.value = '';
    });

    $('#btn-confirm-receipt-items').addEventListener('click', () => {
      let added = 0;
      pendingReceiptItems.forEach((item, idx) => {
        const chk = $(`[data-ext-check="${idx}"]`);
        if (chk && chk.checked) {
          const name = $(`[data-ext-name="${idx}"]`).value.trim();
          const amount = $(`[data-ext-amount="${idx}"]`).value.trim();
          if (name) {
            state.pantry.push({
              id: 'p_' + Date.now() + '_' + idx,
              name,
              amount,
              category: item.category || '食品',
              used: false
            });
            added++;
          }
        }
      });
      saveState();
      closeModal('modal-receipt');
      renderAll();
      showToast(`${added}品の食材を追加しました`);
    });

    $('#btn-add-pantry-manual').addEventListener('click', () => {
      const name = prompt('追加する食材名（例：鶏むね肉 300g）');
      if (!name || !name.trim()) return;
      state.pantry.push({
        id: 'p_' + Date.now(),
        name: name.trim(),
        amount: '',
        category: '食品',
        used: false
      });
      saveState();
      renderAll();
    });

    $('#pantry-list').addEventListener('click', e => {
      const tog = e.target.closest('[data-pantry-toggle]');
      if (tog) {
        const item = state.pantry.find(x => x.id === tog.dataset.pantryToggle);
        if (item) item.used = !item.used;
        saveState();
        renderAll();
        return;
      }
      const del = e.target.closest('[data-pantry-del]');
      if (del) {
        state.pantry = state.pantry.filter(x => x.id !== del.dataset.pantryDel);
        saveState();
        renderAll();
      }
    });

    const bindProfileUpdate = () => {
      const p = state.profile;
      p.weight = Math.max(20, parseFloat($('#prof-weight').value) || p.weight);
      p.height = Math.max(100, parseFloat($('#prof-height').value) || p.height);
      p.age = Math.max(10, parseInt($('#prof-age').value, 10) || p.age);
      p.gender = $('#prof-gender').value;
      p.activity = parseFloat($('#prof-activity').value) || 1.55;
      p.goalOffset = parseInt($('#prof-goal').value, 10) || 0;
      p.useManualTarget = $('#prof-manual-toggle').checked;
      p.manualTarget = parseInt($('#prof-manual-cal').value, 10) || p.manualTarget;
      p.dinnerRatio = parseInt($('#prof-dinner-ratio').value, 10) || 40;
      saveState();
      renderAll();
    };

    ['#prof-weight', '#prof-height', '#prof-age', '#prof-gender', '#prof-activity', '#prof-goal', '#prof-manual-toggle', '#prof-manual-cal', '#prof-dinner-ratio']
      .forEach(sel => $(sel).addEventListener('change', bindProfileUpdate));

    $('#btn-save-weight-log').addEventListener('click', () => recordWeight(state.profile.weight));

    $('#btn-save-api-key').addEventListener('click', () => {
      const val = $('#input-api-key').value.trim();
      localStorage.setItem(API_KEY_STORAGE, val);
      localStorage.removeItem(MODEL_CACHE_STORAGE);
      renderSettingsTab();
      showToast('Gemini APIキーを保存しました');
    });

    $('#btn-clear-api-key').addEventListener('click', () => {
      localStorage.removeItem(API_KEY_STORAGE);
      localStorage.removeItem(MODEL_CACHE_STORAGE);
      renderSettingsTab();
      showToast('APIキーをクリアしました');
    });

    $('#btn-reset-week-menu').addEventListener('click', () => {
      if (!confirm('今週の夕食献立（月〜日）をすべて未設定に戻しますか？')) return;
      state.weeklyMenu = defaultState().weeklyMenu;
      saveState();
      renderAll();
      showToast('今週の献立をクリアしました');
    });

    $('#btn-reset-all').addEventListener('click', () => {
      if (!confirm('食事履歴・献立・食材をすべて初期化しますか？')) return;
      state = defaultState();
      saveState();
      renderAll();
      showToast('全データを初期化しました');
    });
  }

  function recordWeight(weightVal) {
    const todayStr = formatDate(new Date());
    state.profile.weight = weightVal;
    const idx = state.weightHistory.findIndex(h => h.date === todayStr);
    if (idx >= 0) state.weightHistory[idx].weight = weightVal;
    else state.weightHistory.push({ date: todayStr, weight: weightVal });
    saveState();
    renderAll();
    showToast(`${todayStr} の体重（${weightVal} kg）を記録しました`);
  }

  // ================= 起動 =================
  bindEvents();
  renderAll();
})();
