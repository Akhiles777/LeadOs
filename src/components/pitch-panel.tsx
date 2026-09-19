import type { Pitch } from "@/ai/tasks/pitch";
import { PitchButton } from "@/components/ai-panels";

const CONFIDENCE = { high: "уверенно", medium: "скорее да", low: "данных мало — начни с вопросов" } as const;

/** Что предложить компании: решение, почему именно им, цена, срок и бесплатный первый шаг. */
export function PitchPanel({ leadId, pitch, aiReady }: { leadId: string; pitch: Pitch | null; aiReady: boolean }) {
  if (!pitch) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-zinc-500">
          AI посмотрит нишу, сайт и карточку компании, выберет, что им продать (меню, запись в WhatsApp, CRM…), и напишет скрипт звонка,
          сообщение в WhatsApp и письмо.
        </p>
        {aiReady ? <PitchButton leadId={leadId} again={false} /> : <p className="text-xs text-zinc-500">Нужен ключ ROUTERAI_API_KEY — см. раздел «AI».</p>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <p className="text-base font-semibold">{pitch.solutionTitle}</p>
        <p className="mt-1">{pitch.pitch}</p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-zinc-500">Цена</dt>
        <dd className="font-medium">{pitch.price}</dd>
        <dt className="text-zinc-500">Срок</dt>
        <dd>{pitch.timeline}</dd>
        <dt className="text-zinc-500">Первый шаг</dt>
        <dd>{pitch.firstStep}</dd>
        <dt className="text-zinc-500">Уверенность</dt>
        <dd>{CONFIDENCE[pitch.confidence] ?? pitch.confidence}</dd>
      </dl>
      {pitch.whyThem.length > 0 && (
        <div>
          <p className="text-xs font-medium text-zinc-500">Почему именно им</p>
          <ul className="mt-1 list-disc pl-5">
            {pitch.whyThem.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {pitch.alternatives.length > 0 && (
        <div>
          <p className="text-xs font-medium text-zinc-500">Если не зайдёт</p>
          <ul className="mt-1 flex flex-col gap-1">
            {pitch.alternatives.map((a) => (
              <li key={a.solutionId + a.title}>
                <b>{a.title}</b> — {a.why}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-zinc-500">Тексты — в «Черновиках сообщений» ниже. Правь и отправляй сам.</p>
      {aiReady && <PitchButton leadId={leadId} again />}
    </div>
  );
}
