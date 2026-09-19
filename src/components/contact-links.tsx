import type { Lead } from "@/generated/prisma/client";
import { allContacts, CONTACT_LABEL, type Contact, phoneDigits, SOURCE_NOTE } from "@/lib/contacts";

type LeadContacts = Pick<Lead, "contactPhone" | "contactTg" | "contactEmail" | "website" | "sourceRef" | "contacts">;

/** Ссылки «связаться в один тап»: звонок, WhatsApp, Telegram, почта, соцсети, сайт, источник. */
export function contactLinks(lead: LeadContacts) {
  const links: { key: string; href: string; label: string; external?: boolean }[] = [];
  const contacts = allContacts(lead);
  const seen = new Set<string>();
  const add = (key: string, href: string, label: string, external = true) => {
    if (seen.has(href)) return;
    seen.add(href);
    links.push({ key, href, label, external });
  };

  const phone = contacts.find((c) => c.kind === "phone");
  const phoneNum = phone ? phoneDigits(phone.value) : null;
  if (phoneNum) add("tel", `tel:+${phoneNum}`, "Позвонить", false);
  // У малого бизнеса WhatsApp почти всегда на основном номере — кнопка есть, даже если отдельно он не указан.
  const wa = contacts.find((c) => c.kind === "whatsapp");
  const waNum = wa ? phoneDigits(wa.value) : phoneNum;
  if (waNum) add("wa", `https://wa.me/${waNum}`, "WhatsApp");
  for (const c of contacts) {
    if (c.kind === "phone" || c.kind === "whatsapp" || !c.url) continue;
    add(`${c.kind}-${c.value}`, c.url, c.kind === "email" ? "Почта" : CONTACT_LABEL[c.kind], c.kind !== "email");
  }
  if (lead.website && /^https?:\/\//i.test(lead.website)) add("site", lead.website, "Сайт");
  if (lead.sourceRef && /^https?:\/\//i.test(lead.sourceRef)) add("source", lead.sourceRef, "Источник");
  return links;
}

export function ContactLinks({ lead }: { lead: LeadContacts }) {
  const links = contactLinks(lead);
  if (!links.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {links.map((l) => (
        <a
          key={l.key}
          href={l.href}
          {...(l.external ? { target: "_blank", rel: "noreferrer" } : {})}
          className="rounded-full border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {l.label}
        </a>
      ))}
    </div>
  );
}

/** Все найденные каналы с источником: откуда взят номер, чтобы понимать, насколько ему верить. */
export function ContactList({ contacts }: { contacts: Contact[] }) {
  if (!contacts.length) return null;
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {contacts.map((c) => (
        <li key={`${c.kind}|${c.value}`} className="flex flex-wrap items-baseline gap-x-2">
          <span className="w-20 shrink-0 text-xs text-zinc-500">{CONTACT_LABEL[c.kind]}</span>
          {c.url ? (
            <a href={c.url} {...(c.url.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})} className="font-medium tabular-nums underline">
              {c.value}
            </a>
          ) : (
            <span className="font-medium tabular-nums">{c.value}</span>
          )}
          <span className="text-xs text-zinc-500">{c.note ?? SOURCE_NOTE[c.source]}</span>
        </li>
      ))}
    </ul>
  );
}
