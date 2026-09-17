"use client";

import { createContext, type ReactNode, useContext, useState, useTransition } from "react";
import type { LeadStatus } from "@/generated/prisma/enums";
import { changeStatus } from "@/lib/actions";

const MIME = "application/x-leados-lead";
const DragContext = createContext<{ dragging: string | null; setDragging: (id: string | null) => void; pending: boolean; move: (id: string, to: LeadStatus) => void } | null>(null);

/** Перетаскивание карточек между этапами воронки (мышью). На телефоне статус меняется выпадающим списком в карточке. */
export function PipelineBoard({ children }: { children: ReactNode }) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const move = (id: string, to: LeadStatus) => start(() => changeStatus(id, to));
  return <DragContext.Provider value={{ dragging, setDragging, pending, move }}>{children}</DragContext.Provider>;
}

export function DropColumn({ status, children, className }: { status: LeadStatus; children: ReactNode; className: string }) {
  const ctx = useContext(DragContext);
  const [over, setOver] = useState(false);
  return (
    <section
      className={`${className} transition-shadow ${over ? "ring-2 ring-sky-600 dark:ring-sky-500" : ""} ${ctx?.pending ? "opacity-80" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const raw = e.dataTransfer.getData(MIME);
        if (!raw || !ctx) return;
        e.preventDefault();
        const { id, from } = JSON.parse(raw) as { id: string; from: LeadStatus };
        if (from !== status) ctx.move(id, status);
        ctx.setDragging(null);
      }}
    >
      {children}
    </section>
  );
}

export function DragCard({ id, status, children, className }: { id: string; status: LeadStatus; children: ReactNode; className: string }) {
  const ctx = useContext(DragContext);
  return (
    <article
      draggable
      className={`${className} cursor-grab active:cursor-grabbing ${ctx?.dragging === id ? "opacity-40" : ""}`}
      onDragStart={(e) => {
        e.dataTransfer.setData(MIME, JSON.stringify({ id, from: status }));
        e.dataTransfer.effectAllowed = "move";
        ctx?.setDragging(id);
      }}
      onDragEnd={() => ctx?.setDragging(null)}
    >
      {children}
    </article>
  );
}
