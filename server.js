// ============================================================
//  БЭКЕНД: Планировщик квартиры
//  Node.js + Express + Google Gemini API
// ============================================================

const express = require('express');
const multer = require('multer');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*'
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Только изображения'));
  }
});

// ── PROMPT ───────────────────────────────────────────────
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
      "changes": [
        "конкретное изменение 1",
        "конкретное изменение 2",
        "конкретное изменение 3",
        "конкретное изменение 4"
      ],
      "zones": [
        { "name": "Гостиная", "area": "20 м²", "features": "описание" },
        { "name": "Кухня", "area": "12 м²", "features": "описание" }
      ],
      "colors": ["#E8DDD0", "#6B7B8D", "#C4602A"],
      "colorNames": ["слоновая кость", "серо-синий", "терракота"],
      "furniture": ["диван угловой 2.5×1.8м", "обеденный стол 1.2×0.8м"],
      "pros": [
        "преимущество 1",
        "преимущество 2",
        "преимущество 3"
      ],
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
- Все тексты на русском языке
- Учитывай реальные строительные ограничения

Проанализируй данную планировку квартиры и предложи 5-7 вариантов перепланировки. Ответ строго в JSON без каких-либо дополнительных символов.`;

// ── ENDPOINT: POST /analyze ───────────────────────────────
app.post('/analyze', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Файл не загружен' });
  }

  try {
    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY не задан на сервере' });
    }

    // Gemini 2.0 Flash — бесплатный, быстрый, поддерживает изображения
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const body = {
      contents: [{
        parts: [
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Image
            }
          },
          {
            text: PROMPT
          }
        ]
      }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 4000
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const msg = errData?.error?.message || `Ошибка Gemini API: ${response.status}`;

      if (response.status === 400) return res.status(500).json({ error: 'Неверный формат запроса к Gemini.' });
      if (response.status === 403) { console.error('Gemini 403:', msg); return res.status(500).json({ error: 'Неверный API-ключ Gemini.' }); }
      if (response.status === 429) { console.error('Gemini 429:', JSON.stringify(errData)); return res.status(429).json({ error: 'Превышен лимит запросов. Подождите немного.' }); }

      throw new Error(msg);
    }

    const data = await response.json();

    // Извлекаем текст из ответа Gemini
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!rawText) {
      throw new Error('Gemini вернул пустой ответ');
    }

    // Очищаем от markdown-блоков
    const clean = rawText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    const parsed = JSON.parse(clean);

    if (!parsed.variants || !Array.isArray(parsed.variants)) {
      throw new Error('Некорректный ответ от AI');
    }

    res.json(parsed);

  } catch (err) {
    console.error('Ошибка анализа:', err.message);

    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: 'Ошибка обработки ответа AI. Попробуйте ещё раз.' });
    }

    res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
  }
});

// ── HEALTHCHECK ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', model: 'gemini-2.0-flash' });
});

app.listen(PORT, () => {
  console.log(`✓ Сервер запущен: http://localhost:${PORT}`);
  console.log(`  Модель: gemini-2.0-flash (бесплатно)`);
  console.log(`  POST /analyze — анализ планировки`);
  console.log(`  GET  /health  — проверка состояния`);
});
