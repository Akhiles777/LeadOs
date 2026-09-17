"use client";

import { useMemo, useState, useTransition } from "react";
import type { LeadStatus, Source } from "@/generated/prisma/enums";
import { decodeTableFile, parseCsv } from "@/lib/import/csv";
import { beginImport, finishImport, sendImportChunk } from "@/lib/import/actions";
import { buildRecords, type ColumnMapping, guessMapping, IMPORT_FIELDS, type ImportField } from "@/lib/import/mapping";
import { SOURCE_LABEL, SOURCE_ORDER, STATUS_LABEL, STATUS_ORDER } from "@/lib/leads";
import { buttonClass, ghostButtonClass, inputClass } from "@/components/ui";

const MAX_ROWS = 5000;
const CHUNK = 200;
function plural(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const rub = (n: number | null) => (n == null ? "—" : `${n.toLocaleString("ru-RU")} ₽`);

type Result = { created: number; skipped: { row: number; reason: string }[] };

export function ImportWizard() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [table, setTable] = useState<string[][] | null>(null);
  const [pasted, setPasted] = useState("");
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [defaultSource, setDefaultSource] = useState<Source>("MANUAL");
  const [defaultStatus, setDefaultStatus] = useState<LeadStatus>("WON");
  const [wonArePaid, setWonArePaid] = useState(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const load = (text: string, name: string | null) => {
    setError(null);
    setResult(null);
    const rows = parseCsv(text);
    if (rows.length < 2) {
      setError("Нужна строка заголовков и хотя бы одна строка данных");
      return;
    }
    if (rows.length - 1 > MAX_ROWS) {
      setError(`Слишком много строк: ${rows.length - 1}. За раз — до ${MAX_ROWS}, раздели файл.`);
      return;
    }
    setTable(rows);
    setFileName(name);
    setMapping(guessMapping(rows[0]));
  };

  const headers = table?.[0] ?? [];
  const dataRows = useMemo(() => table?.slice(1) ?? [], [table]);
  const options = { defaultSource, defaultStatus, wonArePaid };
  const preview = useMemo(() => (table ? buildRecords(dataRows, mapping, { defaultSource, defaultStatus, wonArePaid }) : []), [table, dataRows, mapping, defaultSource, defaultStatus, wonArePaid]);
  const invalid = preview.filter((r) => r.error).length;
  const withWarnings = preview.filter((r) => r.warnings.length).length;

  const run = () =>
    start(async () => {
      setError(null);
      setResult(null);
      const { id } = await beginImport(fileName);
      const total: Result = { created: 0, skipped: [] };
      setProgress({ done: 0, total: dataRows.length });
      for (let offset = 0; offset < dataRows.length; offset += CHUNK) {
        const res = await sendImportChunk({ batchId: id, offset, rows: dataRows.slice(offset, offset + CHUNK), mapping: mapping as Record<string, number>, options });
        if ("error" in res) {
          setError(`${res.error} (строки ${offset + 2}–${Math.min(offset + CHUNK, dataRows.length) + 1}). Уже импортированное можно отменить ниже.`);
          break;
        }
        total.created += res.created;
        total.skipped.push(...res.skipped);
        setProgress({ done: Math.min(offset + CHUNK, dataRows.length), total: dataRows.length });
      }
      await finishImport();
      setResult(total);
      setTable(null);
    });

  if (result) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-lg font-semibold">
          Импортировано: {result.created}
          {result.skipped.length > 0 && <span className="text-zinc-500"> · пропущено: {result.skipped.length}</span>}
        </p>
        {result.skipped.length > 0 && (
          <details open={result.skipped.length <= 20}>
            <summary className="cursor-pointer text-sm">Пропущенные строки</summary>
            <ul className="mt-2 max-h-72 overflow-y-auto text-xs text-zinc-600 dark:text-zinc-400">
              {result.skipped.map((s) => (
                <li key={s.row}>
                  строка {s.row}: {s.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
        <button type="button" className={`${ghostButtonClass} self-start`} onClick={() => setResult(null)}>
          Импортировать ещё
        </button>
      </div>
    );
  }

  if (!table) {
    return (
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-2 text-sm">
          <span className="font-medium">Файл CSV или TSV</span>
          <input
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 5_000_000) return setError("Файл больше 5 МБ — раздели его");
              if (/\.xlsx?$/i.test(file.name)) return setError("Это файл Excel. Сохрани его как CSV (Файл → Сохранить как → CSV) или скопируй таблицу и вставь ниже.");
              load(decodeTableFile(new Uint8Array(await file.arrayBuffer())), file.name);
            }}
            className="text-sm"
          />
        </label>
        <p className="text-xs text-zinc-500">или</p>
        <label className="flex flex-col gap-2 text-sm">
          <span className="font-medium">Вставь таблицу целиком вместе с заголовками (выдели в Excel или Google Таблицах → Ctrl+C)</span>
          <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={6} className={`${inputClass} font-mono text-xs`} />
        </label>
        <button type="button" disabled={!pasted.trim()} className={`${ghostButtonClass} self-start`} onClick={() => load(pasted, "вставка")}>
          Разобрать вставленное
        </button>
        {error && <p className="text-sm text-rose-600">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm">
        {fileName} · строк данных: <b>{dataRows.length}</b>
        <button type="button" className="ml-3 text-xs underline" onClick={() => setTable(null)}>
          выбрать другой файл
        </button>
      </p>

      <section>
        <h3 className="mb-2 text-sm font-medium">Какая колонка чем является</h3>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(Object.keys(IMPORT_FIELDS) as ImportField[]).map((field) => (
            <label key={field} className="flex flex-col gap-1 text-xs">
              <span className="text-zinc-500">{IMPORT_FIELDS[field].label}</span>
              <select
                value={mapping[field] ?? ""}
                onChange={(e) =>
                  setMapping((m) => {
                    const next = { ...m };
                    if (e.target.value === "") delete next[field];
                    else next[field] = Number(e.target.value);
                    return next;
                  })
                }
                className={`${inputClass} text-sm`}
              >
                <option value="">— нет —</option>
                {headers.map((h, i) => (
                  <option key={i} value={i}>
                    {h || `колонка ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-zinc-500">Источник, если не указан</span>
          <select value={defaultSource} onChange={(e) => setDefaultSource(e.target.value as Source)} className={`${inputClass} text-sm`}>
            {SOURCE_ORDER.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-zinc-500">Статус, если не указан или не распознан</span>
          <select value={defaultStatus} onChange={(e) => setDefaultStatus(e.target.value as LeadStatus)} className={`${inputClass} text-sm`}>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={wonArePaid} disabled={mapping.paid != null} onChange={(e) => setWonArePaid(e.target.checked)} />
          <span>
            Выигранные сделки считать оплаченными полностью
            {mapping.paid != null && <span className="block text-xs text-zinc-500">берётся из колонки «Оплачено»</span>}
          </span>
        </label>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">
          Предпросмотр
          {invalid > 0 && <span className="ml-2 text-rose-600">без названия: {invalid} (будут пропущены)</span>}
          {withWarnings > 0 && <span className="ml-2 text-amber-700 dark:text-amber-400">с предупреждениями: {withWarnings}</span>}
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-zinc-500">
              <tr>
                {["Стр.", "Клиент", "Телефон", "Источник", "Статус", "Сумма", "Оплачено", "Дата", "Замечания"].map((h) => (
                  <th key={h} className="px-2 py-1 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {preview.slice(0, 15).map((r) => (
                <tr key={r.row} className={r.error ? "text-rose-600" : ""}>
                  <td className="px-2 py-1 tabular-nums">{r.row}</td>
                  <td className="px-2 py-1">{r.title || "—"}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{r.contactPhone ?? "—"}</td>
                  <td className="px-2 py-1">{SOURCE_LABEL[r.source]}</td>
                  <td className="px-2 py-1">{STATUS_LABEL[r.status]}</td>
                  <td className="px-2 py-1 whitespace-nowrap tabular-nums">{rub(r.amount)}</td>
                  <td className="px-2 py-1 whitespace-nowrap tabular-nums">{rub(r.paid)}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{r.createdAt ? r.createdAt.toLocaleDateString("ru-RU") : "—"}</td>
                  <td className="px-2 py-1 text-amber-700 dark:text-amber-400">{[r.error, ...r.warnings].filter(Boolean).join("; ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.length > 15 && <p className="mt-1 text-xs text-zinc-500">…и ещё {preview.length - 15} строк</p>}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={pending || mapping.title == null && mapping.contactName == null} className={buttonClass} onClick={run}>
          {pending && progress ? `Импорт… ${progress.done} из ${progress.total}` : `Импортировать: ${dataRows.length - invalid} ${plural(dataRows.length - invalid, "строка", "строки", "строк")}`}
        </button>
        {mapping.title == null && mapping.contactName == null && <span className="text-xs text-rose-600">Укажи колонку с клиентом или контактом</span>}
        <span className="text-xs text-zinc-500">Дубли (телефон, email, то же название в тот же день) пропускаются. AI импортированные лиды не оценивает.</span>
      </div>
      {error && <p className="text-sm text-rose-600">{error}</p>}
    </div>
  );
}
