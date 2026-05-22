const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Только изображения'));
  }
});

const PROMPT = `Ты — профессиональный архитектор-дизайнер, специалист по перепланировке квартир. Анализируешь фотографию или чертёж планировки квартиры и предлагаешь варианты оптимизации пространства.

ВАЖНО: Отвечай ТОЛЬКО в формате JSON. Никакого текста до или после. Никаких markdown-блоков или символов \`\`\`.

Формат ответа:
{
  "analysis": "краткий анализ исходной планировки (2-3 предложения на русском)",
  "totalArea": "примерная площадь если определяется, иначе 'не определена'",
  "rooms": ["список помещений которые видны на планировке"],
  "variants": [
    {
      "number": 1,
      "title": "название варианта (на русском)",
      "style": "стиль интерьера",
      "concept": "концепция в 1-2 предложениях",
      "changes": ["конкретное изменение 1", "конкретное изменение 2", "конкретное изменение 3", "конкретное изменение 4"],
      "zones": [
        { "name": "Гостиная", "area": "20 м²", "features": "описание" },
        { "name": "Кухня", "area": "12 м²", "features": "описание" }
      ],
      "colors": ["#E8DDD0", "#6B7B8D", "#C4602A"],
      "colorNames": ["слоновая кость", "серо-синий", "терракота"],
      "furniture": ["диван угловой 2.5×1.8м", "обеденный стол 1.2×0.8м"],
      "renderPrompt": "English prompt for photorealistic interior render based on this variant, without text or people",
      "pros": ["преимущество 1", "преимущество 2", "преимущество 3"],
      "budget": "эконом",
      "difficulty": "лёгкая"
    }
  ]
}

Правила:
- Предложи РОВНО от 5 до 7 вариантов
- Каждый вариант должен существенно отличаться от других по концепции
- budget: одно из: "эконом" / "средний" / "премиум"
- difficulty: одно из: "лёгкая" / "средняя" / "сложная"
- renderPrompt должен быть на английском, 1 предложение, photorealistic interior design render, no text, no people
- Все тексты на русском языке
- Учитывай реальные строительные ограничения

Проанализируй данную планировку квартиры и предложи 5-7 вариантов перепланировки. Ответ строго в JSON без каких-либо дополнительных символов.`;

function runMiddleware(req, res, middleware) {
  return new Promise((resolve, reject) => {
    middleware(req, res, result => {
      if (result instanceof Error) reject(result);
      else resolve(result);
    });
  });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function callGemini(file, apiKey) {
  const base64Image = file.buffer.toString('base64');
  const mimeType = file.mimetype || 'image/jpeg';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Image } },
        { text: PROMPT }
      ]
    }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 16384,
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  let response;
  for (let attempt = 1; attempt <= 3; attempt++) {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (response.ok) break;

    const errData = await response.json().catch(() => ({}));
    const msg = errData?.error?.message || '';
    if (response.status === 400) throw new Error('Неверный формат запроса к Gemini.');
    if (response.status === 403) throw new Error('Неверный API-ключ Gemini.');
    if (response.status === 429) {
      const err = new Error('Превышен лимит запросов. Подождите немного.');
      err.status = 429;
      throw err;
    }

    const isOverloaded = response.status === 503 || msg.includes('high demand') || msg.includes('overloaded');
    if (isOverloaded && attempt < 3) {
      await new Promise(r => setTimeout(r, attempt * 5000));
      continue;
    }
    throw new Error(msg || `Ошибка Gemini API: ${response.status}`);
  }

  const data = await response.json().catch(() => {
    throw new Error('Ошибка обработки ответа AI. Попробуйте ещё раз.');
  });

  const rawText = (data?.candidates?.[0]?.content?.parts || [])
    .filter(p => p.text && !p.thought)
    .map(p => p.text)
    .join('');

  if (!rawText) throw new Error('Gemini вернул пустой ответ');

  const clean = rawText
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const parsed = JSON.parse(clean);
  if (!parsed.variants || !Array.isArray(parsed.variants)) {
    throw new Error('Некорректный ответ от AI');
  }

  return parsed;
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY не задан на сервере' });
    }

    await runMiddleware(req, res, upload.single('image'));
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }

    const parsed = await callGemini(req.file, apiKey);
    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Ошибка анализа:', err.message);
    return res.status(err.status || 500).json({
      error: err instanceof SyntaxError
        ? 'Ошибка обработки ответа AI. Попробуйте ещё раз.'
        : (err.message || 'Внутренняя ошибка сервера')
    });
  }
};
