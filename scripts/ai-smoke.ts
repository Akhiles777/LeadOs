/**
 * Проверка AI-слоя без реальных вызовов RouterAI: pnpm test:ai
 * Модель подменяется фикстурами; работает с настоящей БД из DATABASE_URL и удаляет за собой всё созданное.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { AI_MODEL, setMessagesApiForTests } from "@/ai/client";
import { claimJob, completeJob, enqueue } from "@/ai/jobs";
import { processNextJob, scheduleDueJobs } from "@/ai/runner";
import { assessLead } from "@/ai/tasks/assess";
import { buildDigest } from "@/ai/tasks/digest";
import { generateDraft } from "@/ai/tasks/drafts";
import { applyRuleChange, suggestTuning, TUNING_KEY } from "@/ai/tasks/tuning";
import { createLeadDeduped } from "@/lib/lead-service";

process.env.ROUTERAI_API_KEY ||= "test-key-not-used";
process.env.AI_PRICE_INPUT_RUB_PER_1M ||= "10";
process.env.AI_PRICE_OUTPUT_RUB_PER_1M ||= "50";
const MARK = `AI-SMOKE-${Date.now()}`;

type RequestParams = {
  model: string;
  temperature?: number;
  reasoning?: { effort: string };
  plugins?: { id: string }[];
  messages: { role: string; content: string }[];
  response_format?: { type: string; json_schema?: { schema?: unknown } };
};
type Captured = { system: string; prompt: string; params: RequestParams };
type DigestJson = { top: { leadId: string }[] };
const calls: Captured[] = [];
let mode: "ok" | "refusal" | "bad" = "ok";
let pitchCalls = 0;
const PITCH = {
  solutionId: "e_menu",
  solutionTitle: "Электронное меню с заказом со стола",
  whyThem: ["Кафе в центре, сайта нет"],
  pitch: "Сделаю меню по QR, заказ сразу на кухню",
  price: "25 000 ₽",
  timeline: "7 дней",
  firstStep: "Демо на 10 блюдах бесплатно",
  alternatives: [],
  confidence: "medium",
  callScript: {
    opening: "Здравствуйте, меня зовут [Имя], звоню по поводу меню",
    hook: "Увидел, что меню только на бумаге",
    relevantCase: "",
    questions: ["Как гости сейчас заказывают?"],
    objections: [{ objection: "Дорого", answer: "Начнём с бесплатного демо" }],
    nextStep: "Показать демо",
    followUpMessage: "Скинул демо меню",
  },
  whatsapp: "Увидел ваше кафе на Ленина — меню только на бумаге. Могу за день собрать QR-меню на 10 ваших блюд, посмотрите?",
  email: { subject: "QR-меню для кафе", body: "Текст письма" },
};

setMessagesApiForTests({
  // Тестовая подмена: возвращаем минимальную форму Chat Completion.
  create: async (params: RequestParams) => {
    const system = params.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const prompt = params.messages.find((m) => m.role === "user")?.content ?? "";
    calls.push({ system, prompt, params });
    const usage = { prompt_tokens: 1200, completion_tokens: 300 };
    if (mode === "refusal") return { model: "openai/gpt-4o", choices: [{ message: { content: "" }, finish_reason: "stop" }], usage };
    if (mode === "bad") return { model: "openai/gpt-4o", choices: [{ message: { content: "{\"text\":123}" }, finish_reason: "stop" }], usage };

    let parsed: unknown;
    let annotations: { type: string; url_citation: { url: string; title: string; content: string } }[] | undefined;
    if (params.plugins?.length) {
      parsed = {
        found: true,
        website: "",
        phones: [
          { value: "+7 (872) 211-22-33", sourceUrl: "https://2gis.ru/firm/42" },
          { value: "+7 900 000-00-00", sourceUrl: "https://2gis.ru/firm/42" },
        ],
        emails: [],
        links: [],
        note: "совпадает адрес",
      };
      annotations = [{ type: "url_citation", url_citation: { url: "https://2gis.ru/firm/42", title: `${MARK} кафе`, content: `${MARK} кафе, тел. +7 (872) 211-22-33` } }];
    } else if (prompt.includes("Подбери, что предложить")) {
      pitchCalls++;
      // Первый вариант со штампом — должен уйти на переписывание.
      parsed = pitchCalls === 1 ? { ...PITCH, whatsapp: "Добрый день! Индивидуальный подход, качественно и в срок." } : PITCH;
    } else if (prompt.includes("Оцени этот лид")) {
      parsed = {
        score: 142, // модель может выйти за границы — задача обязана зажать в 0..100
        verdict: "TAKE",
        summary: "Сайт-визитка для клиники, в стеке, бюджет реалистичный.",
        fit: { specialization: "Next.js — да", budget: "40 000 ₽ — нормально", scope: "3–5 дней" },
        redFlags: [{ kind: "vague_scope", title: "Нет структуры", explanation: "Не указано, какие страницы нужны", severity: "low" }],
        questions: ["Какие услуги показать на сайте?"],
      };
    } else if (prompt.includes("скрипт холодного звонка")) {
      parsed = {
        opening: "Здравствуйте, меня зовут …",
        hook: "Увидел, что у вас нет онлайн-записи",
        relevantCase: "CRM для клиники",
        questions: ["Как сейчас записываются пациенты?"],
        objections: [{ objection: "Дорого", answer: "Окупается за месяц" }],
        nextStep: "Созвон на 15 минут",
        followUpMessage: "Спасибо за разговор!",
      };
    } else if (prompt.includes("<current_rules>")) {
      parsed = {
        observations: ["Черновики переписываются почти полностью"],
        ruleChanges: [{ category: "стиль_отклика", newText: "Без списков. Первой фразой — срок и цена.", why: "В 3 из 3 правок добавлен срок" }],
        caseGaps: [],
      };
    } else if (prompt.includes("утренний дайджест")) {
      const ids = [...prompt.matchAll(/id=(\w+)/g)].map((m) => m[1]);
      parsed = { headline: "Два хороших заказа", top: [{ leadId: ids[0], why: "Высокая оценка" }, { leadId: "hallucinated-id", why: "нет такого" }], skipNote: "" };
    } else {
      parsed = { text: "Здравствуйте! Сделаю сайт для вашей клиники…", notes: "Угол — онлайн-запись" };
    }
    return { model: params.model, choices: [{ message: { content: JSON.stringify(parsed), annotations }, finish_reason: "stop" }], usage };
  },
});

async function cleanup() {
  const leads = await db.lead.findMany({ where: { title: { startsWith: MARK } }, select: { id: true } });
  const ids = leads.map((l) => l.id);
  // Планировщик в тесте видит всю базу и мог поставить задачи и для настоящих лидов — убираем всё, что создано прогоном.
  await db.aiJob.deleteMany({ where: { OR: [{ leadId: { in: ids } }, { createdAt: { gte: started } }] } });
  await db.aiCall.deleteMany({ where: { createdAt: { gte: started } } });
  await db.lead.deleteMany({ where: { id: { in: ids } } });
  await db.portfolioCase.deleteMany({ where: { title: { startsWith: MARK } } });
}
const started = new Date();

async function main() {
  const existingDigest = await db.digest.findFirst({ orderBy: { day: "desc" } });
  try {
    await db.portfolioCase.create({ data: { title: `${MARK} CRM для клиники`, niches: "клиники, стоматологии", summary: "Запись пациентов онлайн" } });

    // 1. Новый лид сам встаёт в очередь на оценку, дубль задачи не создаётся
    const base = { source: "KWORK" as const, rawText: "Нужен сайт для стоматологии, бюджет 40 000", category: null, budgetMin: null, budgetMax: 40000, contactName: null, contactPhone: null, contactTg: null, contactEmail: null, website: null, region: null, followUpAt: null, referredById: null };
    const a = await createLeadDeduped({ ...base, title: `${MARK} сайт для стоматологии`, sourceRef: `https://kwork.ru/projects/9${Date.now() % 1e8}` });
    assert.ok(a.created);
    await enqueue("SCORE_LEAD", a.id);
    assert.equal(await db.aiJob.count({ where: { leadId: a.id, type: "SCORE_LEAD" } }), 1, "одна задача на лид");

    // 2. Два обработчика одновременно не берут одну задачу
    const b = await createLeadDeduped({ ...base, title: `${MARK} второй лид`, sourceRef: `https://kwork.ru/projects/8${Date.now() % 1e8}` });
    const [j1, j2] = await Promise.all([claimJob(), claimJob()]);
    assert.ok(j1 && j2 && j1.id !== j2.id, "разные задачи");
    await db.aiJob.updateMany({ where: { id: { in: [j1!.id, j2!.id] } }, data: { status: "PENDING", attempts: 0, lockedAt: null } });

    // 3. Выполнение очереди: оценка сохраняется, счёт зажат в 0..100
    while (await processNextJob()) {}
    const scored = await db.lead.findUniqueOrThrow({ where: { id: a.id } });
    assert.equal(scored.score, 100);
    assert.equal(scored.aiVerdict, "TAKE");
    assert.deepEqual(scored.redFlags, ["Нет структуры — Не указано, какие страницы нужны"]);
    assert.ok(scored.scoredAt);
    assert.equal(await db.aiJob.count({ where: { leadId: { in: [a.id, b.id] }, status: "DONE" } }), 2);

    // 4. Параметры запроса: модель, structured output, данные лида вне system
    const first = calls[0].params;
    assert.equal(first.model, AI_MODEL);
    assert.equal(first.temperature, undefined, "температура не задаётся — иначе тексты однотипные");
    assert.ok(["low", "medium", "high"].includes(first.reasoning?.effort ?? ""), "уровень рассуждений передаётся");
    assert.equal(first.response_format?.type, "json_schema");
    assert.ok(first.response_format?.json_schema?.schema, "структурированный ответ");
    assert.ok(!calls[0].system.includes("сайт для стоматологии"), "данные лида не попадают в кэшируемую часть");
    assert.ok(calls[0].system.includes("CRM для клиники"), "кейсы в системном промпте");
    assert.equal(calls[0].system, calls[1].system, "системный промпт одинаков между вызовами");

    // 5. Черновики: few-shot — сначала сообщения, приведшие к сделке
    const won = await createLeadDeduped({ ...base, title: `${MARK} выигранный`, sourceRef: null });
    const lost = await createLeadDeduped({ ...base, title: `${MARK} проигранный`, sourceRef: null });
    await db.lead.update({ where: { id: won.id }, data: { status: "WON" } });
    await db.offerDraft.create({ data: { leadId: lost.id, channel: "kwork_response", text: "ОТКЛИК-БЕЗ-СДЕЛКИ", sentAt: new Date() } });
    await db.offerDraft.create({ data: { leadId: won.id, channel: "kwork_response", text: "ОТКЛИК-СО-СДЕЛКОЙ", sentAt: new Date(Date.now() - 86_400_000) } });
    await generateDraft(a.id, "kwork_response");
    const offerPrompt = calls.at(-1)!.prompt;
    assert.ok(offerPrompt.indexOf("ОТКЛИК-СО-СДЕЛКОЙ") < offerPrompt.indexOf("ОТКЛИК-БЕЗ-СДЕЛКИ"), "выигравший пример идёт первым");
    await generateDraft(a.id, "cold_call_script");
    const drafts = await db.offerDraft.findMany({ where: { leadId: a.id }, orderBy: { createdAt: "asc" } });
    assert.equal(drafts.length, 2);
    assert.match(drafts[1].text, /Зацепка:\nУвидел, что у вас нет онлайн-записи/);

    // 6. Отказ модели и кривой ответ: задача повторяется, после 3 попыток — FAILED; ошибка логируется
    mode = "refusal";
    await assert.rejects(assessLead(b.id), /пустой ответ/);
    const job = await enqueue("SCORE_LEAD", b.id);
    for (let i = 0; i < 3; i++) {
      await db.aiJob.update({ where: { id: job.id }, data: { runAfter: new Date(0) } });
      await processNextJob();
    }
    const failed = await db.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.attempts, 3);
    mode = "bad";
    await assert.rejects(generateDraft(b.id, "cold_message"));
    mode = "ok";

    // 7. Учёт расходов
    const log = await db.aiCall.findMany({ where: { createdAt: { gte: started } } });
    assert.ok(log.some((c) => !c.ok && /пустой ответ/.test(c.error ?? "")));
    const okCall = log.find((c) => c.ok)!;
    assert.ok(okCall.costUsd > 0 && okCall.inputTokens === 1200 && okCall.outputTokens === 300);

    // 8. Дайджест: только реальные id, лиды по убыванию оценки
    await db.lead.update({ where: { id: b.id }, data: { score: 35, aiVerdict: "SKIP" } });
    const digest = await buildDigest();
    const summary = digest.summary as unknown as DigestJson;
    assert.ok(digest.leadIds.includes(a.id));
    assert.ok(summary.top.every((t) => t.leadId !== "hallucinated-id"), "выдуманный id отброшен");
    assert.equal(digest.leadIds[0], a.id, "лид с оценкой 100 первый");

    // 9. Зависший лид получает задачу follow-up один раз
    await db.lead.update({ where: { id: lost.id }, data: { status: "CONTACTED", lastActivityAt: new Date(Date.now() - 30 * 86_400_000) } });
    await scheduleDueJobs();
    await scheduleDueJobs();
    assert.equal(await db.aiJob.count({ where: { leadId: lost.id, type: "FOLLOW_UP" } }), 1);
    const fu = await db.aiJob.findFirstOrThrow({ where: { leadId: lost.id, type: "FOLLOW_UP" } });
    {
      await generateDraft(lost.id, "follow_up");
      await completeJob(fu.id);
      await scheduleDueJobs();
      assert.equal(await db.aiJob.count({ where: { leadId: lost.id, type: "FOLLOW_UP", status: "PENDING" } }), 0, "после черновика повторно не ставится");
    }

    // 10. Поправки к оценке попадают в системный промпт
    await db.assessmentFeedback.create({ data: { leadId: a.id, aiScore: 100, aiVerdict: "TAKE", correctVerdict: "SKIP", note: `${MARK} это поддержка 24/7, не разработка` } });
    await assessLead(a.id);
    const withFeedback = calls.at(-1)!.params;
    assert.ok(withFeedback.messages[0].content.includes("поддержка 24/7"));
    assert.ok(withFeedback.messages[0].content.includes(calls[0].params.messages[0].content.split("\n\n")[0]), "основные правила сохраняются");

    // 11. Донастройка: предложение сохраняется, применение заменяет правила категории один раз
    const rulesBefore = await db.personalBrandRule.findMany();
    await db.personalBrandRule.create({ data: { category: "стиль_отклика", content: `${MARK} старое правило` } });
    await db.offerDraft.create({ data: { leadId: won.id, channel: "kwork_response", aiText: "Здравствуйте, сделаю", text: "Добрый день! Срок 5 дней, цена 30 000", sentAt: new Date() } });
    const tuning = await suggestTuning();
    assert.ok(calls.at(-1)!.prompt.includes("Срок 5 дней"), "в анализ попадают отредактированные черновики");
    assert.ok(calls.at(-1)!.prompt.includes("поддержка 24/7"), "и поправки к оценкам");
    assert.equal(tuning.result.ruleChanges.length, 1);
    assert.equal(await applyRuleChange(0), true);
    assert.equal(await applyRuleChange(0), false, "повторно не применяется");
    const style = await db.personalBrandRule.findMany({ where: { category: "стиль_отклика" } });
    assert.deepEqual(style.map((r) => r.content), ["Без списков. Первой фразой — срок и цена."]);
    await db.personalBrandRule.deleteMany();
    if (rulesBefore.length) await db.personalBrandRule.createMany({ data: rulesBefore });
    await db.appSetting.deleteMany({ where: { key: TUNING_KEY } });

    // 12. Холодная компания: проверка сайта → поиск контактов (только подтверждённые) → оффер со штампом переписан
    const cafe = await db.lead.create({
      data: { source: "COLD_LOCAL", title: `${MARK} кафе`, rawText: "Ниша: кафе\nАдрес: Махачкала, Ленина, 1", category: "кафе", region: "Махачкала" },
    });
    await db.aiJob.deleteMany({ where: { status: "PENDING" , createdAt: { gte: started } } });
    await enqueue("COLD_OFFER", cafe.id, new Date(0));
    await enqueue("SITE_CHECK", cafe.id, new Date(1000));
    for (let i = 0; i < 10 && (await processNextJob()); i++) {
      // отложенные задачи ставятся на минуту вперёд — в тесте возвращаем их сразу
      await db.aiJob.updateMany({ where: { leadId: cafe.id, status: "PENDING" }, data: { runAfter: new Date(0) } });
    }
    const jobs = await db.aiJob.findMany({ where: { leadId: cafe.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(jobs.map((j) => `${j.type}:${j.status}`).sort(), ["COLD_OFFER:DONE", "FIND_CONTACTS:DONE", "SITE_CHECK:DONE"]);
    const contactsCall = calls.find((c) => c.params.plugins?.length);
    assert.ok(contactsCall, "поиск контактов с веб-поиском");
    const done = await db.lead.findUniqueOrThrow({ where: { id: cafe.id }, include: { offers: true } });
    assert.equal(done.contactPhone, "+7 872 211-22-33", "подтверждённый номер сохранён");
    assert.ok(!JSON.stringify(done.contacts).includes("900 000"), "выдуманный номер отброшен");
    assert.ok(done.contactsSearchedAt);
    assert.equal((done.pitch as { solutionTitle?: string }).solutionTitle, PITCH.solutionTitle);
    assert.equal(pitchCalls, 2, "текст со штампами переписан один раз");
    assert.deepEqual(done.offers.map((o) => o.channel).sort(), ["cold_call_script", "cold_message"], "письмо не пишем, если почты нет, а телефон есть");
    assert.ok(done.offers.find((o) => o.channel === "cold_message")!.text.startsWith("Увидел ваше кафе"));
    const pitchPrompt = calls.filter((c) => c.prompt.includes("Подбери, что предложить")).at(-1)!.prompt;
    assert.ok(pitchPrompt.includes("<solutions>") && pitchPrompt.includes("e_menu"), "каталог решений в промпте");
    assert.ok(pitchPrompt.includes("Каналы связи: Телефон"), "AI знает, какие есть каналы");

    console.log(`ok — ${calls.length} подменённых вызовов модели, все проверки пройдены`);
  } finally {
    await cleanup();
    // дайджест за сегодня мог быть создан тестом — вернуть как было
    if (!existingDigest) await db.digest.deleteMany({ where: { createdAt: { gte: started } } });
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
