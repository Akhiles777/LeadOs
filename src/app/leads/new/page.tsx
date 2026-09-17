import { createLead } from "@/lib/actions";
import { db } from "@/lib/db";
import { isSource } from "@/lib/leads";
import { ActionForm } from "@/components/action-form";
import { LeadFields } from "@/components/lead-fields";
import { Card, PageHeader } from "@/components/ui";

export default async function NewLeadPage(props: PageProps<"/leads/new">) {
  const { source } = await props.searchParams;
  const referrers = await db.lead.findMany({ where: { status: "WON" }, orderBy: { updatedAt: "desc" }, take: 300, select: { id: true, title: true } });
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Новый лид" subtitle="Рекомендация, случайная встреча, канал вне списка — всё сюда." />
      <Card>
        <ActionForm action={createLead} submitLabel="Добавить лид" resetOnSuccess>
          <LeadFields defaultSource={isSource(source) ? source : "MANUAL"} referrers={referrers} />
        </ActionForm>
      </Card>
    </div>
  );
}
