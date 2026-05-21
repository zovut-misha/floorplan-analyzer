// ============================================================
//  БЭКЕНД: Планировщик квартиры
//  Node.js + Express
// ============================================================

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS: разрешаем запросы с фронтенда ──────────────────
// При деплое замените на реальный домен вашего фронтенда
// Например: 'https://your-frontend.vercel.app'
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*'
}));

// ── Multer: храним файлы в памяти, макс 20MB ─────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Только изображения'));
  }
});

// ── Anthropic клиент ─────────────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ── SYSTEM PROMPT ────────────────────────────────────────
const SYSTEM_PROMPT = `Ты — профессиональный архитектор-дизайнер, специалист по перепланировке квартир. Анализируешь фотографию или чертёж планировки квартиры и предлагаешь варианты оптимизации пространства.

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
- Учитывай реальные строительные ограничения`;

// ── ENDPOINT: POST /analyze ───────────────────────────────
app.post('/analyze', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Файл не загружен' });
  }

  try {
    // Определяем media_type
    const mediaType = req.file.mimetype.startsWith('image/')
      ? req.file.mimetype
      : 'image/jpeg';

    // Конвертируем буфер в base64
    const base64Image = req.file.buffer.toString('base64');

    // Отправляем в Claude API
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Image
            }
          },
          {
            type: 'text',
            text: 'Проанализируй данную планировку квартиры и предложи 5-7 вариантов перепланировки. Ответ строго в JSON без каких-либо дополнительных символов.'
          }
        ]
      }]
    });

    // Парсим JSON из ответа
    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Очищаем от возможных markdown-блоков
    const clean = rawText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    const data = JSON.parse(clean);

    // Базовая валидация
    if (!data.variants || !Array.isArray(data.variants)) {
      throw new Error('Некорректный ответ от AI');
    }

    res.json(data);

  } catch (err) {
    console.error('Ошибка анализа:', err.message);

    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: 'Ошибка обработки ответа AI. Попробуйте ещё раз.' });
    }
    if (err.status === 401) {
      return res.status(500).json({ error: 'Неверный API-ключ Anthropic.' });
    }
    if (err.status === 429) {
      return res.status(429).json({ error: 'Превышен лимит запросов. Подождите немного.' });
    }

    res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
  }
});

// ── HEALTHCHECK ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

app.listen(PORT, () => {
  console.log(`✓ Сервер запущен: http://localhost:${PORT}`);
  console.log(`  POST /analyze — анализ планировки`);
  console.log(`  GET  /health  — проверка состояния`);
});
