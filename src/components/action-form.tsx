"use client";

import Link from "next/link";
import { useActionState, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { FormState } from "@/lib/actions";
import { buttonClass } from "@/components/ui";

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonClass}>
      {pending ? "Сохраняю…" : label}
    </button>
  );
}

export function ActionForm({
  action,
  submitLabel,
  successText,
  resetOnSuccess = false,
  children,
  className = "",
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
  successText?: string;
  resetOnSuccess?: boolean;
  children: ReactNode;
  className?: string;
}) {
  // Результат последнего вызова: React сбрасывает форму после любого action, а при ошибке ввод нужно сохранить.
  const last = useRef<FormState>(undefined);
  const [state, formAction] = useActionState(async (prev: FormState, formData: FormData) => {
    last.current = await action(prev, formData);
    return last.current;
  }, undefined);

  return (
    <form
      action={formAction}
      onReset={(e) => {
        if (!resetOnSuccess || last.current?.error) e.preventDefault();
      }}
      className={`flex flex-col gap-4 ${className}`}
    >
      {children}
      <div className="flex items-center gap-3">
        <Submit label={submitLabel} />
        {state?.error && (
          <p className="text-sm text-rose-600">
            {state.error}
            {state.duplicate && (
              <>
                {": "}
                <Link href={`/leads/${state.duplicate.id}`} className="underline">
                  {state.duplicate.title}
                </Link>
              </>
            )}
          </p>
        )}
        {state?.ok && successText && <p className="text-sm text-emerald-600">{successText}</p>}
      </div>
    </form>
  );
}
