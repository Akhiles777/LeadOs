import type { Lead } from "@/generated/prisma/client";

/** Ссылки «связаться в один тап»: звонок, WhatsApp, Telegram, почта, сайт, источник. */
export function contactLinks(lead: Pick<Lead, "contactPhone" | "contactTg" | "contactEmail" | "website" | "sourceRef">) {
  const links: { key: string; href: string; label: string; external?: boolean }[] = [];
  const digits = lead.contactPhone?.replace(/\D/g, "") ?? "";
  if (digits.length >= 10) {
    const intl = digits.length === 11 && digits.startsWith("8") ? `7${digits.slice(1)}` : digits.length === 10 ? `7${digits}` : digits;
    links.push({ key: "tel", href: `tel:+${intl}`, label: "Позвонить" });
    links.push({ key: "wa", href: `https://wa.me/${intl}`, label: "WhatsApp", external: true });
  }
  const tg = lead.contactTg?.trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "");
  if (tg && /^[a-zA-Z][\w]{3,31}$/.test(tg)) links.push({ key: "tg", href: `https://t.me/${tg}`, label: "Telegram", external: true });
  if (lead.contactEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.contactEmail)) links.push({ key: "mail", href: `mailto:${lead.contactEmail}`, label: "Почта" });
  if (lead.website && /^https?:\/\//i.test(lead.website)) links.push({ key: "site", href: lead.website, label: "Сайт", external: true });
  if (lead.sourceRef && /^https?:\/\//i.test(lead.sourceRef)) links.push({ key: "source", href: lead.sourceRef, label: "Источник", external: true });
  return links;
}

export function ContactLinks({ lead }: { lead: Parameters<typeof contactLinks>[0] }) {
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
