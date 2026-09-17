import { connection } from "next/server";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/leads";
import { UndoImportButton } from "@/components/import-batches";
import { ImportWizard } from "@/components/import-wizard";
import { Card, PageHeader } from "@/components/ui";

export const maxDuration = 300;

export default async function ImportPage() {
  await connection();
  const batches = await db.importBatch.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
  const counts = await db.lead.groupBy({ by: ["importBatch"], where: { importBatch: { in: batches.map((b) => b.id) } }, _count: { _all: true } });
  const alive = new Map(counts.map((c) => [c.importBatch, c._count._all]));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="Импорт из таблицы"
        subtitle="Прошлые клиенты и сделки из Excel или Google Таблиц — чтобы аналитика, рекомендации и повторные продажи сразу опирались на историю."
      />
      <Card>
        <ImportWizard />
      </Card>
      {batches.length > 0 && (
        <Card title="Прошлые импорты">
          <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-900">
            {batches.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {formatDate(b.createdAt, true)} · {b.fileName ?? "без имени"} · создано {b.created}, пропущено {b.skipped}
                  {alive.get(b.id) !== b.created && <span className="text-xs text-zinc-500"> · сейчас в базе {alive.get(b.id) ?? 0}</span>}
                </span>
                {(alive.get(b.id) ?? 0) > 0 && <UndoImportButton id={b.id} count={alive.get(b.id)!} />}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
